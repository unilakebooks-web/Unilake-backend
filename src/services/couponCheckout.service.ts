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
  PreviewDeletedError,
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
  PHONE_KEY_DIGITS,
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
import { phoneKey } from "../utils/phoneKey.js";
import { assertFilesNotDeleted, assertNotExpired } from "./session.service.js";
import { REVENUE_STATUSES } from "../config/stats.js";

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

// ⚠️ The COUPON_ codes below are also listed in unilake-frontend/components/checkout/couponErrors.ts
/** Refusal with the customer-facing message and a stable code the frontend can read. */
function couponError(reason: CouponRejection): AppError {
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
  /** The caller's IP address, so failed code attempts are also counted per address. */
  callerIp?: string;
}

/** A coupon that passed every check for one order, ready to be reserved. */
export interface PricedCoupon {
  couponId: string;
  code: string;
  name: string;
  /** The coupon's updatedAt when it was read; the reservation refuses a coupon that changed since. */
  version: number;
  rules: CouponRules;
  baseContext: Omit<
    CouponContext,
    "now" | "totalUses" | "userUses" | "hasPaidOrder"
  >;
  listAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  finalAmount: Prisma.Decimal;
  currency: string;
  /** The delivery phone the code was priced for, so the reservation re-checks the same customer. */
  phone?: string | null;
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
    firstOrderOnly: row.firstOrderOnly,
  };
}

/**
 * Ids of the orders delivered to the same phone number, so a customer's second
 * account is recognised as the same customer. Empty when the number is missing
 * or too short to compare. Compared by digits only, as phoneKey does; the
 * query below must keep the same rule (digits only, last PHONE_KEY_DIGITS).
 */
async function orderIdsWithSamePhone(db: Db, phone?: string | null) {
  const key = phoneKey(phone);
  if (!key) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders
    WHERE LENGTH(regexp_replace("shippingPhone", '[^0-9]', '', 'g')) >= ${PHONE_KEY_DIGITS}
      AND RIGHT(regexp_replace("shippingPhone", '[^0-9]', '', 'g'), ${PHONE_KEY_DIGITS}) = ${key}`;
  return rows.map((row) => row.id);
}

/**
 * The live uses that are this customer's: on their account, or on an order
 * delivered to the same phone number (`phoneOrderIds`).
 */
function customerUses(
  live: Prisma.CouponRedemptionWhereInput,
  userId: string,
  phoneOrderIds: string[]
): Prisma.CouponRedemptionWhereInput {
  if (phoneOrderIds.length === 0) return { ...live, userId };
  return {
    AND: [live, { OR: [{ userId }, { orderId: { in: phoneOrderIds } }] }],
  };
}

/**
 * Uses that count right now: redeemed ones plus reservations still inside the
 * window. `excludeOrderId` leaves out the order being re-checked, so an unpaid
 * order's own reservation does not count against itself. `phoneOrderIds` also
 * counts the uses on orders delivered to the same phone number as this
 * customer's.
 */
async function countUses(
  db: Db,
  couponId: string,
  userId: string,
  now: Date,
  excludeOrderId?: string,
  phoneOrderIds: string[] = []
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
    where: customerUses(live, userId, phoneOrderIds),
  });
  return { totalUses, userUses };
}

/**
 * Whether the customer already has an order that counts as revenue (paid and
 * not cancelled), which makes any further order not their first. Always read
 * fresh, never cached: a customer can pay another order at any moment.
 */
async function customerHasPaidOrder(
  db: Db,
  userId: string,
  phoneOrderIds: string[] = []
) {
  const ownOrder: Prisma.OrderWhereInput = { orderSession: { userId } };
  const order = await db.order.findFirst({
    where: {
      ...(phoneOrderIds.length === 0
        ? ownOrder
        : { OR: [ownOrder, { id: { in: phoneOrderIds } }] }),
      status: { in: REVENUE_STATUSES },
    },
    select: { id: true },
  });
  return order !== null;
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
  // The code is the one already on the customer's order, so this is not a guess.
  skipAttemptLimit?: boolean;
  // The delivery phone, so uses on the customer's other accounts count too.
  phone?: string | null;
  // The caller's IP address, so a new account does not reset the failed-attempt count.
  ip?: string | null;
}

/**
 * Checks a code the customer typed against this order and works out the
 * discount. Read-only. A refusal counts as a failed attempt; too many failed
 * attempts in a window and further attempts are refused.
 */
export async function priceCoupon(
  args: PriceCouponArgs
): Promise<PricedCoupon> {
  if (
    !args.skipAttemptLimit &&
    (await isCouponAttemptLimited(args.userId, args.ip))
  )
    throw tooManyAttemptsError();

  const refuse = async (reason: CouponRejection): Promise<never> => {
    await recordFailedCouponAttempt(args.userId, args.ip);
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
  const phoneOrderIds = await orderIdsWithSamePhone(prisma, args.phone);
  const counts = await countUses(
    prisma,
    row.id,
    args.userId,
    now,
    args.excludeOrderId,
    phoneOrderIds
  );

  const hasPaidOrder =
    rules.firstOrderOnly &&
    (await customerHasPaidOrder(prisma, args.userId, phoneOrderIds));

  const result = evaluateCoupon(rules, {
    ...baseContext,
    ...counts,
    hasPaidOrder,
    now,
  });
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
    phone: args.phone ?? null,
  };
}

// A session can be priced (previewed, checked out) only in these two states.
function isPriceableStatus(status: string) {
  return status === "PREVIEW_READY" || status === "AWAITING_PAYMENT";
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
): asserts callerUserId is string {
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
  excludeOrderId?: string,
  skipAttemptLimit?: boolean,
  ip?: string
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
    skipAttemptLimit,
    phone: session.shippingPhone,
    ip,
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
  rawCode: string,
  callerIp?: string
) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: { order: true },
  });
  if (!session) throw new NotFoundError("Session not found");

  assertSessionOwner(session, callerUserId);
  await assertNotExpired(session);
  // Automatic data deletion (feature 6): no offers or prices for a preview whose files were deleted.
  assertFilesNotDeleted(session, session.order);

  if (!isPriceableStatus(session.status)) {
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
    callerUserId,
    rawCode,
    session.order?.id,
    undefined,
    callerIp
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
// Offers
// ------------------------------------------------------------

/** The most offers one checkout page shows. */
const MAX_OFFERS = 10;

/**
 * "Which coupons fit this order right now?" Read-only. Lists the coupons
 * reserved for the caller and the public ones the admin chose to show, each run
 * through the same `evaluateCoupon` as checkout with the real counts, so only
 * offers that work right now are returned. Nothing is guessed, so a miss never
 * counts toward the failed-attempt limit.
 *
 * Database cost, independent of how many coupons exist: the session, the price
 * (one query), the candidates, one grouped count of live uses and one for this
 * customer's, plus one paid-order lookup when a candidate is first-order-only. Never calls `priceCoupon` per coupon.
 *
 * A session that cannot be priced yet, or is in the wrong state, has no offers.
 */
export async function listCouponOffers(
  sessionId: string,
  callerUserId: string | undefined
) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) throw new NotFoundError("Session not found");

  assertSessionOwner(session, callerUserId);

  // The expiry check is done inline rather than with assertNotExpired: that
  // function writes to the session, and listing offers is a GET, which must
  // never write.
  const now = new Date();
  if (
    // Automatic data deletion (feature 6): a priceable session with deleted files is unpaid and gone.
    session.filesDeletedAt ||
    session.photoDeletedAt ||
    !isPriceableStatus(session.status) ||
    (session.status === "PREVIEW_READY" && session.expiresAt < now) ||
    !session.coverType ||
    !session.shippingCountry
  ) {
    return { offers: [] };
  }

  // The same price as lookupListPrice, found with the candidates in one round
  // trip; no active country or no price means no offers. If the lookup in
  // lookupListPrice changes, change this with it. A coupon for specific comics
  // is only fetched when it names this one, so its comics need no further
  // query.
  const [country, pricingRule, rows] = await Promise.all([
    prisma.country.findUnique({ where: { code: session.shippingCountry } }),
    prisma.pricingRule.findFirst({
      where: {
        comicId: session.comicId,
        coverType: session.coverType,
        country: { code: session.shippingCountry },
      },
    }),
    prisma.coupon.findMany({
      where: {
        isActive: true,
        AND: [
          {
            OR: [
              { restrictedToUserId: callerUserId },
              {
                kind: "PUBLIC",
                restrictedToUserId: null,
                showAtCheckout: true,
              },
            ],
          },
          {
            OR: [
              { allComics: true },
              { comics: { some: { comicId: session.comicId } } },
            ],
          },
        ],
      },
    }),
  ]);
  if (!country || !country.isActive || !pricingRule || rows.length === 0) {
    return { offers: [] };
  }
  const candidates = rows.map((row) => ({
    ...row,
    comics: row.allComics ? [] : [{ comicId: session.comicId }],
  }));

  const currency = country.currencyCode;
  const baseContext = {
    comicId: session.comicId,
    countryCode: country.code,
    coverType: session.coverType,
    currency,
    exponent: currencyExponent(currency),
    listPrice: pricingRule.price,
    userId: callerUserId,
  };

  // The same "live" uses as countUses, for all candidates at once; the
  // customer's own unpaid order does not count against itself.
  const live: Prisma.CouponRedemptionWhereInput = {
    couponId: { in: candidates.map((c) => c.id) },
    order: { orderSessionId: { not: session.id } },
    OR: [
      { status: "REDEEMED" },
      { status: "RESERVED", createdAt: { gt: reservationCutoff(now) } },
    ],
  };
  // The phone lookup is only needed when some candidate limits uses per customer.
  const phoneOrderIds = candidates.some(
    (c) => c.perCustomerLimit !== null || c.firstOrderOnly
  )
    ? await orderIdsWithSamePhone(prisma, session.shippingPhone)
    : [];
  const [totals, mine] = await Promise.all([
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: live,
      _count: { _all: true },
    }),
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: customerUses(live, callerUserId, phoneOrderIds),
      _count: { _all: true },
    }),
  ]);
  const totalUses = new Map(totals.map((r) => [r.couponId, r._count._all]));
  const userUses = new Map(mine.map((r) => [r.couponId, r._count._all]));

  // One query for the caller, shared by every candidate, and only when some
  // candidate is first-order-only.
  const hasPaidOrder = candidates.some((c) => c.firstOrderOnly)
    ? await customerHasPaidOrder(prisma, callerUserId, phoneOrderIds)
    : false;

  const offers = [];
  for (const row of candidates) {
    const result = evaluateCoupon(toRules(row), {
      ...baseContext,
      now,
      totalUses: totalUses.get(row.id) ?? 0,
      userUses: userUses.get(row.id) ?? 0,
      hasPaidOrder,
    });
    if (!result.ok) continue;
    offers.push({
      code: row.code,
      name: row.name,
      description: row.description,
      forYou: row.restrictedToUserId === callerUserId,
      firstOrderOnly: row.firstOrderOnly,
      endsAt: row.endsAt?.toISOString() ?? null,
      listAmount: pricingRule.price.toString(),
      discountAmount: result.discountAmount.toString(),
      finalAmount: result.finalAmount.toString(),
      currency,
      discount: result.discountAmount,
    });
  }

  // Reserved for the customer first, then the bigger saving, then by code.
  offers.sort(
    (a, b) =>
      Number(b.forYou) - Number(a.forYou) ||
      b.discount.comparedTo(a.discount) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  );

  return {
    offers: offers
      .slice(0, MAX_OFFERS)
      .map(({ discount: _discount, ...offer }) => offer),
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
  const phoneOrderIds = await orderIdsWithSamePhone(tx, priced.phone);
  const counts = await countUses(
    tx,
    priced.couponId,
    userId,
    now,
    orderId,
    phoneOrderIds
  );
  // Fresh, on the transaction's connection: the customer may have paid another
  // order since this one was priced.
  const hasPaidOrder =
    priced.rules.firstOrderOnly &&
    (await customerHasPaidOrder(tx, userId, phoneOrderIds));
  const result = evaluateCoupon(priced.rules, {
    ...priced.baseContext,
    ...counts,
    hasPaidOrder,
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
 * the order to PAID. Turns the order's reservation into a redemption, even one
 * that lapsed: the customer has already paid the discounted price. A RELEASED
 * use (coupon removed, full price paid) is left alone. DB writes only.
 */
export async function redeemCouponInTx(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  const redemption = await tx.couponRedemption.findUnique({
    where: { orderId },
  });
  // A RELEASED use means the customer removed the coupon, so the order was paid
  // at full price: it must not be counted as a use of the coupon.
  if (!redemption || redemption.status !== "RESERVED") return;

  const lapsed = redemption.createdAt <= reservationCutoff(new Date());

  await tx.couponRedemption.updateMany({
    where: { orderId, status: "RESERVED" },
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
 * Automatic data deletion (feature 6): read the deletion marker again inside a transaction that already holds the
 * order row, so a deletion claim that committed meanwhile makes this write roll back instead of creating a payment
 * for a preview whose files are gone.
 */
async function assertSessionFilesKept(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  const marker = await tx.orderSession.findUnique({
    where: { id: sessionId },
    select: { filesDeletedAt: true, photoDeletedAt: true },
  });
  if (marker?.filesDeletedAt || marker?.photoDeletedAt) throw new PreviewDeletedError();
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
  callerIp?: string;
}) {
  const { order, session, couponCode, callerUserId, callerIp } = args;

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
    // Resuming with the code the order already carries changes nothing, so, as
    // before coupons existed, it does not need the owner to be logged in.
    if (fresh) return null;
  }

  assertSessionOwner(session, callerUserId);

  let live;
  try {
    live = await lookupListPrice(session);
  } catch (error) {
    // Resuming with the code the order already carries: if the country was
    // switched off or the price removed since the order was made, the order
    // is still payable as it is, exactly as before coupons existed.
    if (
      requested !== null &&
      requested === existing &&
      (error instanceof NotFoundError || error instanceof ValidationError)
    ) {
      return null;
    }
    throw error;
  }
  const { listPrice, currency } = live;

  let priced: PricedCoupon | null = null;
  if (requested !== null) {
    ({ priced } = await priceCouponForSession(
      session,
      callerUserId,
      requested,
      order.id,
      // Re-pricing the code the order already carries is not a guess, so a
      // customer who is rate-limited can still pay for what they already applied.
      requested === existing,
      callerIp
    ));
  }
  const finalAmount = priced ? priced.finalAmount : listPrice;

  // Same code, lapsed reservation, and the amount did not move: just refresh the
  // reservation in place; the existing Razorpay order is still right.
  if (priced && requested === existing && finalAmount.equals(order.amount)) {
    const pricedNow = priced; // a copy, so the callback below keeps the narrowed type
    const slot = await acquireSlot(`coupon:${priced.couponId}`);
    try {
      await prisma.$transaction(async (tx) => {
        // Lock the order row first: a payment landing right now must not have its
        // redemption turned back into a reservation by this refresh.
        // Unpaid and still the same Razorpay order: if another tab changed the
        // coupon meanwhile, this refresh would put the old code back on it.
        const [row] = await tx.$queryRaw<
          { status: string; razorpayOrderId: string | null }[]
        >`SELECT status, "razorpayOrderId" FROM orders WHERE id = ${order.id} FOR UPDATE`;
        if (
          row?.status !== "CREATED" ||
          row.razorpayOrderId !== order.razorpayOrderId
        ) {
          throw new ConflictError(
            "This order changed while you were applying the code. Please refresh and try again."
          );
        }
        await assertSessionFilesKept(tx, session.id);
        await reserveCouponInTx(tx, {
          priced: pricedNow,
          orderId: order.id,
          userId: callerUserId,
        });
      }, COUPON_TRANSACTION_OPTIONS);
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
      { sessionId: session.id, err: error?.error || error?.message || error },
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
          // Never null here: the update above matched on this id and an order in CREATED has one.
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
      await assertSessionFilesKept(tx, session.id);

      if (priced) {
        await reserveCouponInTx(tx, {
          priced,
          orderId: order.id,
          userId: callerUserId,
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
