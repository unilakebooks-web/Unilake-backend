import { Prisma } from "../generated/prisma/client.js";
import type { CoverType } from "../generated/prisma/client.js";
import {
  MIN_PAYABLE_MAJOR_UNITS,
  RESERVATION_WINDOW_MINUTES,
} from "../config/coupon.js";

/**
 * The rules of a coupon, with no I/O: whether a customer may use it for this
 * order, and how much it takes off. The services load the coupon and the
 * counts, call this, and act on the answer, so every rule is unit-tested here
 * without a database.
 *
 * All money is Prisma.Decimal, never a JS float.
 */

/** Why a coupon was refused. Mapped to a customer message in config/coupon.ts. */
export type CouponRejection =
  | "INVALID"
  | "NOT_STARTED"
  | "EXPIRED"
  | "USED_UP"
  | "ALREADY_USED"
  | "WRONG_CURRENCY"
  | "NOT_APPLICABLE"
  | "FIRST_ORDER_ONLY";

export interface CouponRules {
  isActive: boolean;
  discountType: "PERCENT" | "FIXED";
  percentOff: Prisma.Decimal | null;
  amountOff: Prisma.Decimal | null;
  maxDiscount: Prisma.Decimal | null;
  currency: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  restrictedToUserId: string | null;
  allComics: boolean;
  comicIds: string[];
  countryCodes: string[];
  coverTypes: CoverType[];
  firstOrderOnly: boolean;
}

export interface CouponContext {
  comicId: string;
  countryCode: string;
  coverType: CoverType;
  currency: string;
  /** Decimal places of the order currency: 0, 2 or 3 (see currencyExponent). */
  exponent: number;
  listPrice: Prisma.Decimal;
  userId: string;
  now: Date;
  /** Uses that count right now: redeemed, plus reservations still inside the window. */
  totalUses: number;
  /** The same count for this customer only. */
  userUses: number;
  /** The customer has an order that counts as revenue (see REVENUE_STATUSES). Read only when the coupon is first-order-only. */
  hasPaidOrder: boolean;
}

export type CouponEvaluation =
  | {
      ok: true;
      discountAmount: Prisma.Decimal;
      finalAmount: Prisma.Decimal;
    }
  | { ok: false; reason: CouponRejection };

/**
 * How much a coupon takes off a price.
 *
 * Percent coupons take percentOff of the price, limited by maxDiscount when set;
 * fixed coupons take amountOff. The result is rounded half-up to the currency's
 * decimal places, then limited so the customer still pays at least the payment
 * minimum (see MIN_PAYABLE_MAJOR_UNITS). Never negative.
 */
export function computeDiscount(
  listPrice: Prisma.Decimal,
  rules: Pick<
    CouponRules,
    "discountType" | "percentOff" | "amountOff" | "maxDiscount"
  >,
  exponent: number
): Prisma.Decimal {
  let discount: Prisma.Decimal;

  if (rules.discountType === "PERCENT") {
    discount = listPrice.mul(rules.percentOff ?? 0).div(100);
    if (rules.maxDiscount !== null && discount.gt(rules.maxDiscount)) {
      discount = rules.maxDiscount;
    }
  } else {
    discount = rules.amountOff ?? new Prisma.Decimal(0);
  }

  discount = discount.toDecimalPlaces(exponent, Prisma.Decimal.ROUND_HALF_UP);

  // Rounded down so the limit itself is a whole number of the currency's units.
  const room = listPrice
    .minus(MIN_PAYABLE_MAJOR_UNITS)
    .toDecimalPlaces(exponent, Prisma.Decimal.ROUND_DOWN);

  if (discount.gt(room)) discount = room;
  if (discount.lt(0)) discount = new Prisma.Decimal(0);

  return discount;
}

/**
 * Decides whether this customer may use the coupon for this order.
 *
 * Checked in this order, and the first failure wins:
 *   1. reserved for someone else -> INVALID   (before anything that would reveal
 *                                              the code exists, e.g. "expired")
 *   2. past its end date        -> EXPIRED    (whether or not the switch is on:
 *                                              the expiry sweep switches it off)
 *   3. inactive                 -> INVALID
 *      not started yet          -> NOT_STARTED
 *   4. currency -> WRONG_CURRENCY; comic, country, cover type -> NOT_APPLICABLE
 *   5. first-order-only and the customer already has a paid order
 *                               -> FIRST_ORDER_ONLY (before the limits, so a
 *                                  returning customer is told the true reason)
 *   6. total limit reached      -> USED_UP
 *   7. per-customer limit       -> ALREADY_USED
 *   8. the discount would be zero (price already at the minimum) -> NOT_APPLICABLE
 *
 * startsAt and endsAt are both inclusive: a coupon is valid at the exact
 * instant it starts and at the exact instant it ends.
 */
export function evaluateCoupon(
  rules: CouponRules,
  ctx: CouponContext
): CouponEvaluation {
  if (
    rules.restrictedToUserId !== null &&
    rules.restrictedToUserId !== ctx.userId
  ) {
    return { ok: false, reason: "INVALID" };
  }

  if (rules.endsAt !== null && ctx.now > rules.endsAt) {
    return { ok: false, reason: "EXPIRED" };
  }

  if (!rules.isActive) return { ok: false, reason: "INVALID" };

  if (rules.startsAt !== null && ctx.now < rules.startsAt) {
    return { ok: false, reason: "NOT_STARTED" };
  }

  if (
    rules.currency !== null &&
    rules.currency.toUpperCase() !== ctx.currency.toUpperCase()
  ) {
    return { ok: false, reason: "WRONG_CURRENCY" };
  }
  if (!rules.allComics && !rules.comicIds.includes(ctx.comicId)) {
    return { ok: false, reason: "NOT_APPLICABLE" };
  }
  if (
    rules.countryCodes.length > 0 &&
    !rules.countryCodes.some(
      (code) => code.toUpperCase() === ctx.countryCode.toUpperCase()
    )
  ) {
    return { ok: false, reason: "NOT_APPLICABLE" };
  }
  if (
    rules.coverTypes.length > 0 &&
    !rules.coverTypes.includes(ctx.coverType)
  ) {
    return { ok: false, reason: "NOT_APPLICABLE" };
  }

  if (rules.firstOrderOnly && ctx.hasPaidOrder) {
    return { ok: false, reason: "FIRST_ORDER_ONLY" };
  }

  if (rules.usageLimit !== null && ctx.totalUses >= rules.usageLimit) {
    return { ok: false, reason: "USED_UP" };
  }
  if (
    rules.perCustomerLimit !== null &&
    ctx.userUses >= rules.perCustomerLimit
  ) {
    return { ok: false, reason: "ALREADY_USED" };
  }

  const discountAmount = computeDiscount(ctx.listPrice, rules, ctx.exponent);
  if (discountAmount.lte(0)) return { ok: false, reason: "NOT_APPLICABLE" };

  return {
    ok: true,
    discountAmount,
    finalAmount: ctx.listPrice.minus(discountAmount),
  };
}

/** Reservations created before this instant no longer count against a limit. */
export function reservationCutoff(now: Date): Date {
  return new Date(now.getTime() - RESERVATION_WINDOW_MINUTES * 60 * 1000);
}
