/**
 * Cross-field rules for a coupon, with no I/O. The same rules the CHECK
 * constraints in the coupons migration enforce, applied first so the admin gets
 * a clear message instead of a database error. Used for create (the input) and
 * for update (the stored coupon merged with the changes).
 */

export interface CouponShape {
  kind: "PUBLIC" | "SINGLE_USE";
  discountType: "PERCENT" | "FIXED";
  percentOff: number | null;
  amountOff: number | null;
  maxDiscount: number | null;
  currency: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  allComics: boolean;
  comicCount: number;
}

/** Returns every problem found; an empty list means the coupon is well formed. */
export function couponShapeIssues(coupon: CouponShape): string[] {
  const issues: string[] = [];

  if (coupon.discountType === "PERCENT") {
    if (coupon.percentOff === null) {
      issues.push("A percentage coupon needs a percentage.");
    } else if (coupon.percentOff <= 0 || coupon.percentOff > 100) {
      issues.push("The percentage must be above 0 and at most 100.");
    }
    if (coupon.amountOff !== null) {
      issues.push("A percentage coupon cannot also have a fixed amount.");
    }
  } else {
    if (coupon.amountOff === null) {
      issues.push("A fixed coupon needs an amount.");
    } else if (coupon.amountOff <= 0) {
      issues.push("The amount must be greater than 0.");
    }
    if (coupon.percentOff !== null) {
      issues.push("A fixed coupon cannot also have a percentage.");
    }
    if (coupon.maxDiscount !== null) {
      issues.push("A maximum discount only applies to a percentage coupon.");
    }
  }

  if (coupon.maxDiscount !== null && coupon.maxDiscount <= 0) {
    issues.push("The maximum discount must be greater than 0.");
  }

  // An amount only means something in one currency.
  const needsCurrency =
    coupon.discountType === "FIXED" || coupon.maxDiscount !== null;
  if (needsCurrency && coupon.currency === null) {
    issues.push(
      "Choose a currency: a fixed amount or a maximum discount only applies in one currency."
    );
  }
  if (coupon.currency !== null && !/^[A-Z]{3}$/.test(coupon.currency)) {
    issues.push("The currency must be a 3-letter code such as INR.");
  }

  if (
    coupon.startsAt !== null &&
    coupon.endsAt !== null &&
    coupon.endsAt <= coupon.startsAt
  ) {
    issues.push("The end date must be after the start date.");
  }

  if (!coupon.allComics && coupon.comicCount === 0) {
    issues.push(
      "Choose at least one comic, or apply the coupon to all comics."
    );
  }

  if (coupon.usageLimit !== null && coupon.usageLimit < 1) {
    issues.push("The total usage limit must be at least 1.");
  }
  if (coupon.perCustomerLimit !== null && coupon.perCustomerLimit < 1) {
    issues.push("The per-customer limit must be at least 1.");
  }

  if (coupon.kind === "SINGLE_USE" && coupon.usageLimit !== 1) {
    issues.push("A single-use coupon can be used exactly once.");
  }

  return issues;
}
