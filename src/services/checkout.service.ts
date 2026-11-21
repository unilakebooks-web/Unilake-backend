import { prisma } from "../lib/prisma.js";
import { razorpay, toSmallestUnit } from "../lib/razorpay.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import {
  AppError,
  ConflictError,
  PreviewDeletedError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import type { OrderSession } from "../generated/prisma/client.js";
import { assertFilesNotDeleted, assertNotExpired } from "./session.service.js";
import { COUPON_TRANSACTION_OPTIONS } from "../config/coupon.js";
import { SAMPLE_REFUSAL_MESSAGE } from "../config/sample.js";
import { acquireSlot } from "../utils/keyedQueue.js";
import {
  assertSessionOwner,
  couponResponseFields,
  priceCoupon,
  repriceUnpaidOrder,
  reserveCouponInTx,
  type CheckoutCouponOptions,
  type PricedCoupon,
} from "./couponCheckout.service.js";

/**
 * Matches `@default("singleton")` on SiteSetting.id — the same fixed key
 * siteSetting.service.ts uses. Duplicated as a local constant rather than
 * imported so this module does not depend on a CMS service just to read one
 * boolean.
 */
const SITE_SETTING_SINGLETON_ID = "singleton";

/**
 * Shown to the customer when the store is not accepting orders.
 *
 * This exact string is thrown as the error message, and the frontend's payment
 * handler renders `error.message` directly as a toast — so editing it here
 * changes what the customer reads, with no client change.
 *
 * ⚠️ The storefront banner in the frontend repo carries its own copy of this
 * wording (OrdersPausedBanner). Two repos, so the duplication is unavoidable;
 * change both together.
 */
const ORDERS_PAUSED_MESSAGE =
  "We're not accepting orders right now — but feel free to preview any comic you like.";

function assertShippingComplete(session: OrderSession): void {
  const required: (keyof OrderSession)[] = [
    "shippingName",
    "shippingLine1",
    "shippingCity",
    "shippingState",
    "shippingZip",
    "shippingCountry",
    "shippingPhone",
  ];

  const missing = required.filter((field) => !session[field]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required shipping fields: ${missing.join(", ")}`
    );
  }
}

/**
 * Initiate checkout for a session.
 *
 * Flow:
 *   1. Fetch session (+ its Order, if any); assert it exists and is not expired.
 *   2. Idempotency FIRST: if an Order already exists for this session:
 *        - status CREATED: reuse it, return the existing Razorpay order id.
 *        - any other status: 409 (already paid, or past checkout).
 *   3. Status guard — must be PREVIEW_READY.
 *   4. Must have userId attached.
 *   5. Must have coverType.
 *   6. Must have all shipping fields.
 *   7. Look up Country by ISO code -> countryId + currency.
 *   8. Look up PricingRule(comicId, countryId, coverType) -> price.
 *   9. Create Razorpay order (external API, OUTSIDE transaction).
 *  10. Create Order row + flip session to AWAITING_PAYMENT (transaction).
 *      Then return the payload the frontend needs to open the Razorpay modal.
 *
 * Steps 3-6 are only reachable on a fresh checkout, because step 2 returns or
 * throws whenever an Order row exists.
 *
 * Step 2 MUST stay above step 3. This function itself flips the session
 * PREVIEW_READY -> AWAITING_PAYMENT, so on any second call the status guard
 * rejects first. With the guard first the reuse branch was unreachable, and a
 * user who closed the Razorpay modal was stranded at AWAITING_PAYMENT holding
 * an unpaid CREATED order with no way to retry.
 */

export async function initiateCheckout(
  sessionId: string,
  options: CheckoutCouponOptions = {}
) {
  // 1. Fetch session
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: {
      order: true, // may or may not exist
      comic: { select: { id: true, title: true } },
    },
  });

  if (!session) {
    throw new NotFoundError("Session not found");
  }

  if (session.isSample) {
    throw new ConflictError(SAMPLE_REFUSAL_MESSAGE);
  }

  await assertNotExpired(session);
  // Automatic data deletion (feature 6): a preview whose files were deleted never reaches a payment window.
  assertFilesNotDeleted(session, session.order);

  // 2. Idempotency: existing order?
  //
  // Deliberately ABOVE the status guard — see the flow note on this function.
  // The Order row is the authoritative record that checkout already happened,
  // so it is the strongest signal available and we return on it early. The
  // guards below then only run on a genuinely fresh checkout, which makes the
  // invariant explicit: no Order row => the session must still be PREVIEW_READY.
  //
  // The field guards (userId / coverType / shipping) are intentionally NOT
  // re-run on this path. They were validated when the order was created, and
  // updateOrderSession's post-payment lock has frozen those fields ever since,
  // so a resume is effectively a pure read.
  if (session.order) {
    if (session.order.status === "CREATED") {
      // Nullable in the schema. It is always written at creation today, but a
      // null slipping through would hand the frontend `undefined` and the
      // Razorpay modal would silently fail to open with nothing logged.
      if (!session.order.razorpayOrderId) {
        logger.error(
          { sessionId, orderId: session.order.id },
          "Existing CREATED order has no razorpayOrderId — cannot resume checkout"
        );
        throw new ConflictError(
          "This order is in an inconsistent state and cannot be resumed. Please contact support."
        );
      }

      // Converge the session if it ever drifted back to PREVIEW_READY while an
      // order existed. A no-op in the normal case (already AWAITING_PAYMENT),
      // and the status guard means it can never stomp a paid session.
      await prisma.orderSession.updateMany({
        where: { id: sessionId, status: "PREVIEW_READY" },
        data: { status: "AWAITING_PAYMENT" },
      });

      logger.info(
        { sessionId, orderId: session.order.id, razorpayOrderId: session.order.razorpayOrderId },
        "Checkout re-initiated — reusing existing CREATED order"
      );

      // The customer applied, changed or removed a coupon after starting checkout
      // (couponCode undefined means: keep the order exactly as it is).
      if (options.couponCode !== undefined) {
        const repriced = await repriceUnpaidOrder({
          order: session.order,
          session,
          couponCode: options.couponCode,
          callerUserId: options.callerUserId,
        });
        if (repriced) return repriced;
      }

      // Amount comes off the Order snapshot, never a fresh PricingRule lookup.
      // If an admin edited the price since, a recomputed amount would disagree
      // with the amount the Razorpay order was actually created for and the
      // gateway would reject the payment.
      return {
        orderId: session.order.id,
        razorpayOrderId: session.order.razorpayOrderId,
        razorpayKeyId: config.razorpay.razorpayKeyId,
        amount: toSmallestUnit(session.order.amount.toNumber(), session.order.currency),
        currency: session.order.currency,
        displayAmount: session.order.amount.toString(),
        notificationEmail: session.order.notificationEmail,
        ...couponResponseFields(session.order),
      };
    }
    // Any other status — user has already paid or moved past checkout
    throw new ConflictError(
      `An order already exists for this session with status ${session.order.status}. Cannot re-initiate checkout.`
    );
  }

  // 2b. STORE STATUS — are we accepting new orders at all?
  //
  // Placement is load-bearing. The block above ALWAYS returns (a resumable
  // CREATED order) or throws (already paid), so everything below it is only
  // reachable on a genuinely FRESH checkout. That is exactly the rule we want:
  //
  //   - already holding an unpaid Razorpay order  -> returned above, can finish
  //   - starting checkout for the first time      -> blocked here
  //
  // Someone who had already opened the payment modal when the switch was
  // flipped is not stranded mid-payment, and their Razorpay order expires on
  // its own after 15 minutes either way. Moving this check any higher would
  // break that for no gain.
  //
  // FAIL OPEN. `findUnique` returns null when no settings row has ever been
  // saved, and null must mean "allowed" — it matches the column's own
  // `@default(true)`, and a missing row silently closing the store is a far
  // worse failure than the reverse.
  //
  // ConflictError (409) rather than a new 503 class: the message is what the
  // customer sees. The frontend's payment handler already surfaces
  // `error.message` as a toast, so no client change is needed for this to
  // reach them.
  const storeStatus = await prisma.siteSetting.findUnique({
    where: { id: SITE_SETTING_SINGLETON_ID },
    select: { acceptingOrders: true },
  });

  if (storeStatus && !storeStatus.acceptingOrders) {
    logger.info(
      { sessionId, comicId: session.comicId },
      "Checkout blocked — store is not accepting orders"
    );
    throw new ConflictError(ORDERS_PAUSED_MESSAGE);
  }

  // 3. Status guard — only reachable when no Order row exists for this session.
  if (session.status !== "PREVIEW_READY") {
    throw new ConflictError(
      `Session must be in PREVIEW_READY status to checkout. Current: ${session.status}`
    );
  }

  // 4. Must have userId attached
  if (!session.userId) {
    throw new ValidationError(
      "You must be logged in to proceed with payment. Please log in and try again."
    );
  }

  // 5. Must have coverType
  if (!session.coverType) {
    throw new ValidationError("Please select a cover type before proceeding to payment.");
  }

  // 6. Must have shipping filled
  assertShippingComplete(session);

  // 7. Look up country
  const country = await prisma.country.findUnique({
    where: { code: session.shippingCountry! },
  });

  if (!country) {
    throw new NotFoundError(
      `Country '${session.shippingCountry}' not found. Please contact support.`
    );
  }

  if (!country.isActive) {
    throw new ValidationError(
      `We do not currently ship to ${country.name}. Please choose a different country.`
    );
  }

  // 8. Look up pricing rule
  const pricingRule = await prisma.pricingRule.findUnique({
    where: {
      comicId_countryId_coverType: {
        comicId: session.comicId,
        countryId: country.id,
        coverType: session.coverType,
      },
    },
  });

  if (!pricingRule) {
    logger.error(
      {
        comicId: session.comicId,
        countryId: country.id,
        countryCode: country.code,
        coverType: session.coverType,
      },
      "Pricing rule missing for checkout — configuration gap"
    );
    throw new NotFoundError(
      `Pricing not configured for this comic in ${country.name} (${session.coverType}). Please contact support.`
    );
  }

  // Optional coupon: priced here on the server, then reserved together with the
  // order below. With no coupon, payableAmount is exactly the pricing rule's price.
  let priced: PricedCoupon | null = null;
  if (options.couponCode) {
    assertSessionOwner(session, options.callerUserId);
    priced = await priceCoupon({
      userId: session.userId!,
      rawCode: options.couponCode,
      comicId: session.comicId,
      countryCode: country.code,
      coverType: session.coverType,
      currency: country.currencyCode,
      listPrice: pricingRule.price,
    });
  }
  const payableAmount = priced ? priced.finalAmount : pricingRule.price;

  const priceInMajorUnits = payableAmount.toNumber();
  const amountSmallestUnit = toSmallestUnit(priceInMajorUnits, country.currencyCode);
  const isInternational = country.code !== "IN";

  // 9. Create Razorpay order — OUTSIDE transaction (external API)
  let razorpayOrder;
  try {
    razorpayOrder = await razorpay.orders.create({
      amount: amountSmallestUnit,
      currency: country.currencyCode,
      receipt: `session_${sessionId.slice(0, 30)}`, // Razorpay caps receipt at 40 chars
      notes: {
        sessionId,
        comicId: session.comicId,
        userId: session.userId,
        coverType: session.coverType,
      },
    });
  } catch (error: any) {
    logger.error(
      { sessionId, error: error?.error || error?.message || error },
      "Razorpay order creation failed"
    );
    throw new Error("Payment gateway is temporarily unavailable. Please try again.");
  }

  // 10. Persist Order row + flip session status — inside transaction
  //
  // With a coupon, wait for this coupon's turn first, in memory, so queued
  // customers do not each hold a database connection while they wait for the
  // coupon's row lock. Released in the finally below.
  const releaseCouponSlot = priced ? await acquireSlot(`coupon:${priced.couponId}`) : null;
  try {
    const order = await prisma.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          orderSessionId: sessionId,
          amount: payableAmount,
          currency: country.currencyCode,
          countryCode: country.code,
          coverType: session.coverType!,
          notificationEmail: session.notificationEmail,
          shippingName: session.shippingName,
          shippingLine1: session.shippingLine1,
          shippingLine2: session.shippingLine2,
          shippingCity: session.shippingCity,
          shippingState: session.shippingState,
          shippingZip: session.shippingZip,
          shippingCountry: session.shippingCountry,
          shippingPhone: session.shippingPhone,
          razorpayOrderId: razorpayOrder.id,
          status: "CREATED",
          isInternational,
          ...(priced && {
            listAmount: pricingRule.price,
            discountAmount: priced.discountAmount,
            couponCode: priced.code,
          }),
        },
      });

      // Reserve the coupon use in the same transaction as the order, so a refused
      // coupon (used up in the meantime, or edited) leaves no order behind.
      if (priced) {
        await reserveCouponInTx(tx, {
          priced,
          orderId: createdOrder.id,
          userId: session.userId!,
        });
      }

      // Flip session status via updateMany + guard, so a concurrent update can't race us
      await tx.orderSession.updateMany({
        where: { id: sessionId, status: "PREVIEW_READY" },
        data: { status: "AWAITING_PAYMENT" },
      });

      // Automatic data deletion (feature 6): the deletion claim locks the session row, and this insert holds a key
      // share lock on it, so whichever commits first is seen by the other. Read the marker again after the write:
      // a claim that committed while the Razorpay order was being created rolls this order back.
      const deleted = await tx.orderSession.findUnique({
        where: { id: sessionId },
        select: { filesDeletedAt: true, photoDeletedAt: true },
      });
      if (deleted?.filesDeletedAt || deleted?.photoDeletedAt) {
        throw new PreviewDeletedError();
      }

      return createdOrder;
    }, priced ? COUPON_TRANSACTION_OPTIONS : undefined);

    logger.info(
      {
        sessionId,
        orderId: order.id,
        razorpayOrderId: razorpayOrder.id,
        amount: amountSmallestUnit,
        currency: country.currencyCode,
      },
      "Checkout initiated — Order created and Razorpay order linked"
    );

    return {
      orderId: order.id,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: config.razorpay.razorpayKeyId,
      amount: amountSmallestUnit,
      currency: country.currencyCode,
      displayAmount: payableAmount.toString(),
      notificationEmail: order.notificationEmail,
      ...couponResponseFields(order),
    };
  } catch (error: any) {
    // DB write failed after Razorpay order created — orphan on Razorpay side.
    // Razorpay auto-expires unused orders after 15 min. Log so ops can investigate.
    logger.error(
      {
        sessionId,
        razorpayOrderId: razorpayOrder.id,
        error: error?.message || error,
      },
      "Order row creation failed AFTER Razorpay order created — orphan Razorpay order will auto-expire"
    );
    // A coupon refusal is for the customer, not a failed save: keep its own message.
    if (error instanceof AppError && error.code.startsWith("COUPON_")) throw error;
    if (error instanceof PreviewDeletedError) throw error;
    throw new Error("Failed to save order. Please try again.");
  } finally {
    releaseCouponSlot?.();
  }
}
