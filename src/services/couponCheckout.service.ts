import { Prisma } from "../generated/prisma/client.js";
import type {
  CoverType,
  Order,
  OrderSession,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import { currencyExponent, razorpay, toSmallestUnit } from "../lib/razorpay.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../utils/errors.js";
import {
  COUPON_MESSAGES,
  COUPON_TRANSACTION_OPTIONS,
} from "../config/coupon.js";
import {
  evaluateCoupon,
  reservationCutoff,
  type CouponContext,
  type CouponRejection,
  type CouponRules,
} from "../utils/couponPricing.js";
import { isValidCouponCode, normalizeCouponCode } from "../utils/couponCode.js";
import {
  isCouponAttemptLimited,
  recordFailedCouponAttempt,
} from "../utils/attemptLimiter.js";
import { acquireSlot } from "../utils/keyedQueue.js";
import { assertNotExpired } from "./session.service.js";

// ============================================================
// COUPONS AT CHECKOUT
// ============================================================
//
// Everything coupon-specific on the customer side lives here so the existing
// checkout and webhook code only gains a few additive lines.
//
// The money rules, in short:
//   - The price is always recomputed on the server; nothing the browser sends
//     can set an amount.
//   - A use is RESERVED when the unpaid order is created, in the same
//     transaction as the order, under the coupon's row lock. The limits are
//     enforced by counting redemption rows under that lock, so two customers
//     can never both take the last use.
//   - A reservation older than the window stops counting (no background job).
//   - The payment turns it into REDEEMED, whatever its state: the customer has
//     already paid the discounted price.

type Db = Prisma.TransactionClient | typeof prisma;

/** Refusal with the customer-facing message and a stable code the frontend can read. */
export function couponError(reason: CouponRejection): AppError {
  return new AppError(COUPON_MESSAGES[reason], 400, `COUPON_${reason}`);
}

const changedRetryError = () =>
  new AppError(COUPON_MESSAGES.CHANGED_RETRY, 409, "COUPON_CHANGED_RETRY");

const tooManyAttemptsError = () =>
  new AppError(
    COUPON_MESSAGES.TOO_MANY_ATTEMPTS,
    429,
    "COUPON_TOO_MANY_ATTEMPTS"
  );

/**
 * The optional coupon part of a checkout request.
 * couponCode: undefined keeps the order as it is, a code applies or replaces
 * its coupon, null removes it. callerUserId is the logged-in caller, if any.
 */
export interface CheckoutCouponOptions {
  couponCode?: string | null;
  callerUserId?: string;
}

/** A coupon that passed every check for one order, ready to be reserved. */
export interface PricedCoupon {
  couponId: string;
  code: string;
  name: string;
  /** The coupon's updatedAt when it was read; the reservation refuses a coupon that changed since. */
  version: number;
  rules: CouponRules;
  baseContext: Omit<CouponContext, "now" | "totalUses" | "userUses">;
  listAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  finalAmount: Prisma.Decimal;
  currency: string;
}

/** The coupon fields added to every checkout response. */
export function couponResponseFields(order: {
  listAmount: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  couponCode: string | null;
}) {
  return {
    listAmount: order.listAmount?.toString() ?? null,
    discountAmount: order.discountAmount.toString(),
    couponCode: order.couponCode,
  };
}

// ------------------------------------------------------------
// Loading and counting
// ------------------------------------------------------------

type CouponWithComics = Prisma.CouponGetPayload<{
  include: { comics: { select: { comicId: true } } };
}>;

function toRules(row: CouponWithComics): CouponRules {
  return {
    isActive: row.isActive,
    discountType: row.discountType,
    percentOff: row.percentOff,
    amountOff: row.amountOff,
    maxDiscount: row.maxDiscount,
    currency: row.currency,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    usageLimit: row.usageLimit,
    perCustomerLimit: row.perCustomerLimit,
    restrictedToUserId: row.restrictedToUserId,
    allComics: row.allComics,
    comicIds: row.comics.map((c) => c.comicId),
    countryCodes: row.countryCodes,
    coverTypes: row.coverTypes,
  };
}

/**
 * Uses that count right now: redeemed ones plus reservations still inside the
 * window. `excludeOrderId` leaves out the order being re-checked, so an unpaid
 * order's own reservation does not count against itself.
 */
async function countUses(
  db: Db,
  couponId: string,
  userId: string,
  now: Date,
  excludeOrderId?: string
) {
  const live: Prisma.CouponRedemptionWhereInput = {
    couponId,
    ...(excludeOrderId && { orderId: { not: excludeOrderId } }),
    OR: [
      { status: "REDEEMED" },
      { status: "RESERVED", createdAt: { gt: reservationCutoff(now) } },
    ],
  };
  const totalUses = await db.couponRedemption.count({ where: live });
  const userUses = await db.couponRedemption.count({
    where: { ...live, userId },
  });
  return { totalUses, userUses };
}

// ------------------------------------------------------------
// Pricing a code for an order
// ------------------------------------------------------------

interface PriceCouponArgs {
  userId: string;
  rawCode: string;
  comicId: string;
  countryCode: string;
  coverType: CoverType;
  currency: string;
  listPrice: Prisma.Decimal;
  excludeOrderId?: string;
}

/**
 * Checks a code the customer typed against this order and works out the
 * discount. Read-only. A refusal counts as a failed attempt; too many failed
 * attempts in a window and further attempts are refused.
 */
export async function priceCoupon(
  args: PriceCouponArgs
): Promise<PricedCoupon> {
  if (await isCouponAttemptLimited(args.userId)) throw tooManyAttemptsError();

  const refuse = async (reason: CouponRejection): Promise<never> => {
    await recordFailedCouponAttempt(args.userId);
    logger.info({ reason }, "Coupon refused");
    throw couponError(reason);
  };

  const code = normalizeCouponCode(args.rawCode);
  if (!isValidCouponCode(code)) return refuse("INVALID");

  const row = await prisma.coupon.findUnique({
    where: { code },
    include: { comics: { select: { comicId: true } } },
  });
  if (!row) return refuse("INVALID");

  const rules = toRules(row);
  const baseContext = {
    comicId: args.comicId,
    countryCode: args.countryCode,
    coverType: args.coverType,
    currency: args.currency,
    exponent: currencyExponent(args.currency),
    listPrice: args.listPrice,
    userId: args.userId,
  };
  const now = new Date();
  const counts = await countUses(
    prisma,
    row.id,
    args.userId,
    now,
    args.excludeOrderId
  );

  const result = evaluateCoupon(rules, { ...baseContext, ...counts, now });
  if (!result.ok) return refuse(result.reason);

  logger.info({ couponId: row.id }, "Coupon applied to a checkout");
  return {
    couponId: row.id,
    code: row.code,
    name: row.name,
    version: row.updatedAt.getTime(),
    rules,
    baseContext,
    listAmount: args.listPrice,
    discountAmount: result.discountAmount,
    finalAmount: result.finalAmount,
    currency: args.currency,
  };
}

/**
 * The price list lookup `initiateCheckout` does (the country by ISO code, then
 * the pricing rule for the comic, country and cover type), repeated here so a
 * preview shows exactly what checkout will charge. If the lookup in
 * checkout.service.ts ever changes, change this with it.
 */
async function lookupListPrice(session: {
  comicId: string;
  shippingCountry: string | null;
  coverType: CoverType | null;
}) {
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

  const pricingRule = await prisma.pricingRule.findUnique({
    where: {
      comicId_countryId_coverType: {
        comicId: session.comicId,
        countryId: country.id,
        coverType: session.coverType!,
      },
    },
  });
  if (!pricingRule) {
    throw new NotFoundError(
      `Pricing not configured for this comic in ${country.name} (${session.coverType}). Please contact support.`
    );
  }

  return {
    listPrice: pricingRule.price,
    currency: country.currencyCode,
    countryCode: country.code,
  };
}

/** Only the customer who owns the session may apply or change a coupon on it. */
export function assertSessionOwner(
  session: { userId: string | null },
  callerUserId: string | undefined
) {
  if (!callerUserId)
    throw new UnauthorizedError("Please log in to use a coupon.");
  if (session.userId !== callerUserId) {
    throw new ForbiddenError(
      "You do not have permission to use a coupon on this session"
    );
  }
}

/** Prices a coupon for an order that has a cover type and a delivery country. */
async function priceCouponForSession(
  session: OrderSession,
  userId: string,
  rawCode: string,
  excludeOrderId?: string
) {
  const { listPrice, currency, countryCode } = await lookupListPrice(session);
  const priced = await priceCoupon({
    userId,
    rawCode,
    comicId: session.comicId,
    countryCode,
    coverType: session.coverType!,
    currency,
    listPrice,
    excludeOrderId,
  });
  return { priced, listPrice, currency };
}

// ------------------------------------------------------------
// Preview
// ------------------------------------------------------------

/**
 * "What would I pay with this code?" Read-only: nothing is created or reserved.
 * Requires the logged-in owner of the session.
 */
export async function previewCoupon(
  sessionId: string,
  callerUserId: string | undefined,
  rawCode: string
) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: { order: true },
  });
  if (!session) throw new NotFoundError("Session not found");

  await assertNotExpired(session);
  assertSessionOwner(session, callerUserId);

  if (
    session.status !== "PREVIEW_READY" &&
    session.status !== "AWAITING_PAYMENT"
  ) {
    throw new ConflictError(
      `Session must be ready for checkout. Current: ${session.status}`
    );
  }
  if (session.order && session.order.status !== "CREATED") {
    throw new ConflictError(
      "An order already exists for this session and cannot be changed."
    );
  }
  if (!session.coverType || !session.shippingCountry) {
    throw new ValidationError(
      "Please choose a cover type and a delivery address before applying a code."
    );
  }

  const { priced } = await priceCouponForSession(
    session,
    callerUserId!,
    rawCode,
    session.order?.id
  );

  return {
    code: priced.code,
    name: priced.name,
    listAmount: priced.listAmount.toString(),
    discountAmount: priced.discountAmount.toString(),
    finalAmount: priced.finalAmount.toString(),
    currency: priced.currency,
  };
}

// ------------------------------------------------------------
// Reserving, redeeming, releasing (inside the caller's transaction)
// ------------------------------------------------------------

/**
 * Reserves one use of the coupon for an order, inside the transaction that
 * creates or changes the order. Locks the coupon row, so the checks below and
 * the insert cannot be interleaved with another customer's or an admin's edit.
 *
 * Refuses (and the caller's transaction rolls back) if the coupon changed since
 * it was priced, or a limit was reached in the meantime. Makes no Redis or
 * external call.
 */
export async function reserveCouponInTx(
  tx: Prisma.TransactionClient,
  args: { priced: PricedCoupon; orderId: string; userId: string }
) {
  const { priced, orderId, userId } = args;

  const locked = await tx.$queryRaw<{ updatedAt: Date }[]>`
    SELECT "updatedAt" FROM coupons WHERE id = ${priced.couponId} FOR UPDATE`;
  // Same version means the same rules, so the rules read earlier are still true.
  if (
    locked.length === 0 ||
    locked[0]!.updatedAt.getTime() !== priced.version
  ) {
    throw changedRetryError();
  }

  const now = new Date();
  const counts = await countUses(tx, priced.couponId, userId, now, orderId);
  const result = evaluateCoupon(priced.rules, {
    ...priced.baseContext,
    ...counts,
    now,
  });
  if (!result.ok) throw couponError(result.reason);
  if (!result.discountAmount.equals(priced.discountAmount))
    throw changedRetryError();

  await tx.couponRedemption.upsert({
    where: { orderId },
    create: {
      couponId: priced.couponId,
      orderId,
      userId,
      status: "RESERVED",
      discountAmount: priced.discountAmount,
    },
    update: {
      couponId: priced.couponId,
      userId,
      status: "RESERVED",
      discountAmount: priced.discountAmount,
      createdAt: now,
      redeemedAt: null,
      releasedAt: null,
      releaseReason: null,
    },
  });

  logger.info({ couponId: priced.couponId, orderId }, "Coupon use reserved");
}

/** Marks the order's reservation released (the customer removed the coupon). */
export async function releaseCouponInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  reason: string
) {
  const { count } = await tx.couponRedemption.updateMany({
    where: { orderId, status: "RESERVED" },
    data: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason },
  });
  if (count > 0) logger.info({ orderId, reason }, "Coupon use released");
}

/**
 * Called from the payment-captured transaction, only by the delivery that flips
 * the order to PAID. Turns the order's reservation into a redemption whatever
 * its state: the customer has already paid the discounted price. DB writes only.
 */
export async function redeemCouponInTx(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  const redemption = await tx.couponRedemption.findUnique({
    where: { orderId },
  });
  if (!redemption || redemption.status === "REDEEMED") return;

  const lapsed =
    redemption.status === "RELEASED" ||
    redemption.createdAt <= reservationCutoff(new Date());

  await tx.couponRedemption.updateMany({
    where: { orderId, status: { in: ["RESERVED", "RELEASED"] } },
    data: {
      status: "REDEEMED",
      redeemedAt: new Date(),
      releasedAt: null,
      releaseReason: null,
    },
  });

  if (lapsed) {
    logger.warn(
      {
        orderId,
        couponId: redemption.couponId,
        previousStatus: redemption.status,
      },
      "Coupon redeemed by a payment after its reservation had lapsed; its usage limit may now be exceeded"
    );
  }
}

/** The order that an earlier (replaced) Razorpay order belonged to, if any. */
export function findOrderBySupersededRazorpayOrderId(razorpayOrderId: string) {
  return prisma.order.findFirst({
    where: { supersededRazorpayOrderIds: { has: razorpayOrderId } },
    select: { id: true, status: true, razorpayOrderId: true },
  });
}

// ------------------------------------------------------------
// Changing the coupon on an unpaid order
// ------------------------------------------------------------

/**
 * What an unpaid order's checkout returns to the browser. The same fields the
 * existing resume path returns, plus the coupon ones.
 */
function checkoutPayload(
  order: Order,
  razorpayOrderId: string,
  amount: Prisma.Decimal
) {
  return {
    orderId: order.id,
    razorpayOrderId,
    razorpayKeyId: config.razorpay.razorpayKeyId,
    amount: toSmallestUnit(amount.toNumber(), order.currency),
    currency: order.currency,
    displayAmount: amount.toString(),
    notificationEmail: order.notificationEmail,
    ...couponResponseFields(order),
  };
}

/**
 * Applies, replaces or removes the coupon on an order that is still unpaid.
 *
 * `couponCode`: a code applies or replaces it; null removes it. Returns null
 * when nothing needs to change (the caller resumes the order as it is), or the
 * new checkout payload when the amount changed.
 *
 * A Razorpay order's amount cannot be edited, so a change creates a new Razorpay
 * order and swaps it onto the same Order row, keeping the old id in
 * supersededRazorpayOrderIds so a late payment on it is flagged, not lost.
 */
export async function repriceUnpaidOrder(args: {
  order: Order;
  session: OrderSession;
  couponCode: string | null;
  callerUserId: string | undefined;
}) {
  const { order, session, couponCode, callerUserId } = args;
  assertSessionOwner(session, callerUserId);

  const requested =
    couponCode === null || couponCode.trim() === ""
      ? null
      : normalizeCouponCode(couponCode);
  const existing = order.couponCode;

  if (requested === null && existing === null) return null;

  // The same code as before: nothing to do while its reservation is fresh.
  if (requested !== null && requested === existing) {
    const redemption = await prisma.couponRedemption.findUnique({
      where: { orderId: order.id },
    });
    const fresh =
      redemption?.status === "RESERVED" &&
      redemption.createdAt > reservationCutoff(new Date());
    if (fresh) return null;
  }

  const { listPrice, currency } = await lookupListPrice(session);

  let priced: PricedCoupon | null = null;
  if (requested !== null) {
    ({ priced } = await priceCouponForSession(
      session,
      callerUserId!,
      requested,
      order.id
    ));
  }
  const finalAmount = priced ? priced.finalAmount : listPrice;

  // Same code, lapsed reservation, and the amount did not move: just refresh the
  // reservation in place; the existing Razorpay order is still right.
  if (priced && requested === existing && finalAmount.equals(order.amount)) {
    const slot = await acquireSlot(`coupon:${priced.couponId}`);
    try {
      await prisma.$transaction(
        (tx) =>
          reserveCouponInTx(tx, {
            priced: priced!,
            orderId: order.id,
            userId: callerUserId!,
          }),
        COUPON_TRANSACTION_OPTIONS
      );
    } finally {
      slot();
    }
    return null;
  }

  // The amount changes: a new Razorpay order (outside any transaction, as in checkout).
  let razorpayOrder;
  try {
    razorpayOrder = await razorpay.orders.create({
      amount: toSmallestUnit(finalAmount.toNumber(), currency),
      currency,
      receipt: `session_${session.id.slice(0, 30)}`,
      notes: {
        sessionId: session.id,
        comicId: session.comicId,
        userId: session.userId ?? "",
        coverType: session.coverType ?? "",
      },
    });
  } catch (error: any) {
    logger.error(
      { sessionId: session.id, error: error?.error || error?.message || error },
      "Razorpay order creation failed while changing a coupon"
    );
    throw new Error(
      "Payment gateway is temporarily unavailable. Please try again."
    );
  }

  const slot = priced ? await acquireSlot(`coupon:${priced.couponId}`) : null;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Guarded on the status and the Razorpay id we read: if the customer paid,
      // or changed the coupon in another tab, in the meantime this matches nothing.
      const { count } = await tx.order.updateMany({
        where: {
          id: order.id,
          status: "CREATED",
          razorpayOrderId: order.razorpayOrderId,
        },
        data: {
          razorpayOrderId: razorpayOrder.id,
          supersededRazorpayOrderIds: { push: order.razorpayOrderId! },
          amount: finalAmount,
          listAmount: priced ? listPrice : null,
          discountAmount: priced ? priced.discountAmount : 0,
          couponCode: priced ? priced.code : null,
        },
      });
      if (count !== 1) {
        throw new ConflictError(
          "This order changed while you were applying the code. Please refresh and try again."
        );
      }

      if (priced) {
        await reserveCouponInTx(tx, {
          priced,
          orderId: order.id,
          userId: callerUserId!,
        });
      } else {
        await releaseCouponInTx(tx, order.id, "coupon removed by the customer");
      }

      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    }, COUPON_TRANSACTION_OPTIONS);

    logger.info(
      { orderId: order.id, withCoupon: priced !== null },
      "Unpaid order repriced; the previous Razorpay order was superseded"
    );
    return checkoutPayload(updated, razorpayOrder.id, finalAmount);
  } finally {
    slot?.();
  }
}
