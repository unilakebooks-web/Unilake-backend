import { describe, it, expect } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import {
  computeDiscount,
  evaluateCoupon,
  reservationCutoff,
  type CouponContext,
  type CouponRules,
} from "../../src/utils/couponPricing.js";

const D = (value: string | number) => new Prisma.Decimal(value);

const NOW = new Date("2026-11-16T10:00:00.000Z");

function rules(overrides: Partial<CouponRules> = {}): CouponRules {
  return {
    isActive: true,
    discountType: "PERCENT",
    percentOff: D(20),
    amountOff: null,
    maxDiscount: null,
    currency: null,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    perCustomerLimit: null,
    restrictedToUserId: null,
    allComics: true,
    comicIds: [],
    countryCodes: [],
    coverTypes: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<CouponContext> = {}): CouponContext {
  return {
    comicId: "comic-1",
    countryCode: "IN",
    coverType: "HARDCOVER",
    currency: "INR",
    exponent: 2,
    listPrice: D("999.00"),
    userId: "user-1",
    now: NOW,
    totalUses: 0,
    userUses: 0,
    ...overrides,
  };
}

describe("computeDiscount", () => {
  it("takes a percentage of the price", () => {
    expect(computeDiscount(D("999.00"), rules(), 2).toFixed(2)).toBe("199.80");
  });

  it("limits a percentage coupon by its maximum discount", () => {
    const r = rules({ percentOff: D(50), maxDiscount: D(300) });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("300.00");
  });

  it("does not apply the cap when the discount is below it", () => {
    const r = rules({ percentOff: D(10), maxDiscount: D(300) });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("99.90");
  });

  it("takes a fixed amount", () => {
    const r = rules({
      discountType: "FIXED",
      percentOff: null,
      amountOff: D(100),
    });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("100.00");
  });

  it("never leaves less than the payment minimum (fixed amount larger than the price)", () => {
    const r = rules({
      discountType: "FIXED",
      percentOff: null,
      amountOff: D(5000),
    });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("998.00");
  });

  it("100% off still leaves the minimum to pay", () => {
    const r = rules({ percentOff: D(100) });
    const discount = computeDiscount(D("599.00"), r, 2);
    expect(discount.toFixed(2)).toBe("598.00");
    expect(D("599.00").minus(discount).toFixed(2)).toBe("1.00");
  });

  it("99.9% off is also limited to leave the minimum", () => {
    const r = rules({ percentOff: D("99.9") });
    expect(computeDiscount(D("599.00"), r, 2).toFixed(2)).toBe("598.00");
  });

  it("gives no discount when the price is already at or below the minimum", () => {
    expect(computeDiscount(D("1.00"), rules(), 2).toFixed(2)).toBe("0.00");
    expect(computeDiscount(D("0.50"), rules(), 2).toFixed(2)).toBe("0.00");
  });

  it("rounds half-up to two decimals", () => {
    // 599 x 12.5% = 74.875 exactly, which must round up to 74.88
    expect(
      computeDiscount(D("599.00"), rules({ percentOff: D("12.5") }), 2).toFixed(
        2
      )
    ).toBe("74.88");
    // 14.99 x 12.5% = 1.87375, which rounds down to 1.87
    expect(
      computeDiscount(D("14.99"), rules({ percentOff: D("12.5") }), 2).toFixed(
        2
      )
    ).toBe("1.87");
  });

  it("rounds to whole units for a zero-decimal currency", () => {
    // 999 x 12.5% = 124.875 -> 125
    expect(
      computeDiscount(D("999"), rules({ percentOff: D("12.5") }), 0).toString()
    ).toBe("125");
  });

  it("limits to a whole number of units for a zero-decimal currency", () => {
    const r = rules({
      discountType: "FIXED",
      percentOff: null,
      amountOff: D(5000),
    });
    // room = 999.50 - 1 = 998.50, rounded down to 998
    expect(computeDiscount(D("999.50"), r, 0).toString()).toBe("998");
  });

  it("rounds to three decimals for a three-decimal currency", () => {
    // 10.500 x 33.333% = 3.499965 -> 3.500
    expect(
      computeDiscount(
        D("10.500"),
        rules({ percentOff: D("33.333") }),
        3
      ).toFixed(3)
    ).toBe("3.500");
  });

  it("treats a missing percentage or amount as no discount", () => {
    expect(
      computeDiscount(D("999.00"), rules({ percentOff: null }), 2).toFixed(2)
    ).toBe("0.00");
    const fixed = rules({
      discountType: "FIXED",
      percentOff: null,
      amountOff: null,
    });
    expect(computeDiscount(D("999.00"), fixed, 2).toFixed(2)).toBe("0.00");
  });

  it("never returns a negative discount", () => {
    const r = rules({
      discountType: "FIXED",
      percentOff: null,
      amountOff: D(-5),
    });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("0.00");
  });

  it("uses the cap when it equals the computed discount", () => {
    const r = rules({ percentOff: D(10), maxDiscount: D("99.90") });
    expect(computeDiscount(D("999.00"), r, 2).toFixed(2)).toBe("99.90");
  });
});

describe("evaluateCoupon", () => {
  it("accepts a valid coupon and returns the discount and the final amount", () => {
    const result = evaluateCoupon(rules(), ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discountAmount.toFixed(2)).toBe("199.80");
      expect(result.finalAmount.toFixed(2)).toBe("799.20");
    }
  });

  it("refuses an inactive coupon as INVALID", () => {
    expect(evaluateCoupon(rules({ isActive: false }), ctx())).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  describe("reserved for one customer", () => {
    it("accepts that customer", () => {
      expect(
        evaluateCoupon(rules({ restrictedToUserId: "user-1" }), ctx()).ok
      ).toBe(true);
    });

    it("refuses anyone else as INVALID, even when the coupon is also expired or out of scope", () => {
      const secret = rules({
        restrictedToUserId: "someone-else",
        endsAt: new Date("2026-01-01T00:00:00.000Z"),
        allComics: false,
      });
      expect(evaluateCoupon(secret, ctx())).toEqual({
        ok: false,
        reason: "INVALID",
      });
    });
  });

  describe("validity dates (both ends inclusive)", () => {
    it("is valid at the exact instant it starts", () => {
      expect(evaluateCoupon(rules({ startsAt: NOW }), ctx()).ok).toBe(true);
    });

    it("is NOT_STARTED one millisecond before it starts", () => {
      const startsAt = new Date(NOW.getTime() + 1);
      expect(evaluateCoupon(rules({ startsAt }), ctx())).toEqual({
        ok: false,
        reason: "NOT_STARTED",
      });
    });

    it("is valid at the exact instant it ends", () => {
      expect(evaluateCoupon(rules({ endsAt: NOW }), ctx()).ok).toBe(true);
    });

    it("is EXPIRED one millisecond after it ends", () => {
      const endsAt = new Date(NOW.getTime() - 1);
      expect(evaluateCoupon(rules({ endsAt }), ctx())).toEqual({
        ok: false,
        reason: "EXPIRED",
      });
    });

    it("has no date limits when both are null", () => {
      expect(
        evaluateCoupon(rules({ startsAt: null, endsAt: null }), ctx()).ok
      ).toBe(true);
    });
  });

  describe("currency", () => {
    it("accepts any currency when the coupon has none", () => {
      expect(
        evaluateCoupon(rules({ currency: null }), ctx({ currency: "USD" })).ok
      ).toBe(true);
    });

    it("accepts the matching currency, ignoring case", () => {
      expect(
        evaluateCoupon(rules({ currency: "inr" }), ctx({ currency: "INR" })).ok
      ).toBe(true);
    });

    it("refuses a different currency as WRONG_CURRENCY", () => {
      const r = rules({
        currency: "INR",
        percentOff: D(10),
        maxDiscount: D(100),
      });
      expect(evaluateCoupon(r, ctx({ currency: "USD" }))).toEqual({
        ok: false,
        reason: "WRONG_CURRENCY",
      });
    });
  });

  describe("scope", () => {
    it("ignores the comic list when allComics is true", () => {
      expect(
        evaluateCoupon(rules({ allComics: true, comicIds: ["other"] }), ctx())
          .ok
      ).toBe(true);
    });

    it("accepts a listed comic and refuses an unlisted one", () => {
      expect(
        evaluateCoupon(
          rules({ allComics: false, comicIds: ["comic-1"] }),
          ctx()
        ).ok
      ).toBe(true);
      expect(
        evaluateCoupon(rules({ allComics: false, comicIds: ["other"] }), ctx())
      ).toEqual({
        ok: false,
        reason: "NOT_APPLICABLE",
      });
    });

    it("treats an empty country list as every country, and matches case-insensitively", () => {
      expect(evaluateCoupon(rules({ countryCodes: [] }), ctx()).ok).toBe(true);
      expect(
        evaluateCoupon(
          rules({ countryCodes: ["in"] }),
          ctx({ countryCode: "IN" })
        ).ok
      ).toBe(true);
      expect(evaluateCoupon(rules({ countryCodes: ["US"] }), ctx())).toEqual({
        ok: false,
        reason: "NOT_APPLICABLE",
      });
    });

    it("treats an empty cover list as every cover type", () => {
      expect(evaluateCoupon(rules({ coverTypes: [] }), ctx()).ok).toBe(true);
      expect(
        evaluateCoupon(rules({ coverTypes: ["HARDCOVER"] }), ctx()).ok
      ).toBe(true);
      expect(
        evaluateCoupon(rules({ coverTypes: ["SOFTCOVER"] }), ctx())
      ).toEqual({
        ok: false,
        reason: "NOT_APPLICABLE",
      });
    });
  });

  describe("usage limits", () => {
    it("is USED_UP once the total limit is reached, and fine one below it", () => {
      expect(
        evaluateCoupon(rules({ usageLimit: 5 }), ctx({ totalUses: 4 })).ok
      ).toBe(true);
      expect(
        evaluateCoupon(rules({ usageLimit: 5 }), ctx({ totalUses: 5 }))
      ).toEqual({
        ok: false,
        reason: "USED_UP",
      });
    });

    it("is unlimited when the limit is null", () => {
      expect(
        evaluateCoupon(
          rules({ usageLimit: null }),
          ctx({ totalUses: 1_000_000 })
        ).ok
      ).toBe(true);
    });

    it("is ALREADY_USED once this customer has reached their limit", () => {
      expect(
        evaluateCoupon(rules({ perCustomerLimit: 2 }), ctx({ userUses: 1 })).ok
      ).toBe(true);
      expect(
        evaluateCoupon(rules({ perCustomerLimit: 2 }), ctx({ userUses: 2 }))
      ).toEqual({
        ok: false,
        reason: "ALREADY_USED",
      });
    });
  });

  describe("order of the checks", () => {
    it("reports an out-of-scope coupon as NOT_APPLICABLE before a reached limit", () => {
      const r = rules({ allComics: false, comicIds: ["other"], usageLimit: 1 });
      expect(evaluateCoupon(r, ctx({ totalUses: 1 }))).toEqual({
        ok: false,
        reason: "NOT_APPLICABLE",
      });
    });

    it("reports the total limit before the per-customer limit", () => {
      const r = rules({ usageLimit: 1, perCustomerLimit: 1 });
      expect(evaluateCoupon(r, ctx({ totalUses: 1, userUses: 1 }))).toEqual({
        ok: false,
        reason: "USED_UP",
      });
    });

    it("reports an expired coupon before an out-of-scope one", () => {
      const r = rules({
        endsAt: new Date(NOW.getTime() - 1),
        allComics: false,
        comicIds: [],
      });
      expect(evaluateCoupon(r, ctx())).toEqual({
        ok: false,
        reason: "EXPIRED",
      });
    });

    it("reports a coupon past its end date as EXPIRED even when it is switched off (the expiry sweep does that)", () => {
      const r = rules({ isActive: false, endsAt: new Date(NOW.getTime() - 1) });
      expect(evaluateCoupon(r, ctx())).toEqual({
        ok: false,
        reason: "EXPIRED",
      });
    });

    it("reports a coupon switched off by hand, with an end date still ahead, as INVALID", () => {
      const r = rules({ isActive: false, endsAt: new Date(NOW.getTime() + 1) });
      expect(evaluateCoupon(r, ctx())).toEqual({
        ok: false,
        reason: "INVALID",
      });
    });

    it("reports a switched-off coupon that has not started as INVALID, not NOT_STARTED", () => {
      const r = rules({
        isActive: false,
        startsAt: new Date(NOW.getTime() + 1),
      });
      expect(evaluateCoupon(r, ctx())).toEqual({
        ok: false,
        reason: "INVALID",
      });
    });

    it("keeps a coupon reserved for someone else INVALID even when it has expired", () => {
      const r = rules({
        restrictedToUserId: "someone-else",
        isActive: false,
        endsAt: new Date(NOW.getTime() - 1),
      });
      expect(evaluateCoupon(r, ctx())).toEqual({
        ok: false,
        reason: "INVALID",
      });
    });
  });

  it("refuses with NOT_APPLICABLE when the price is already at the minimum (zero discount)", () => {
    expect(evaluateCoupon(rules(), ctx({ listPrice: D("1.00") }))).toEqual({
      ok: false,
      reason: "NOT_APPLICABLE",
    });
  });

  it("leaves at least the payment minimum on a 100% coupon", () => {
    const result = evaluateCoupon(
      rules({ percentOff: D(100) }),
      ctx({ listPrice: D("599.00") })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finalAmount.toFixed(2)).toBe("1.00");
  });
});

describe("reservationCutoff", () => {
  it("is exactly the reservation window before now", () => {
    expect(reservationCutoff(NOW).toISOString()).toBe(
      "2026-11-16T09:00:00.000Z"
    );
  });
});
