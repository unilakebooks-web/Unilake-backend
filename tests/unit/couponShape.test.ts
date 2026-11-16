import { describe, it, expect } from "vitest";
import {
  couponShapeIssues,
  type CouponShape,
} from "../../src/utils/couponShape.js";

function shape(overrides: Partial<CouponShape> = {}): CouponShape {
  return {
    kind: "PUBLIC",
    discountType: "PERCENT",
    percentOff: 20,
    amountOff: null,
    maxDiscount: null,
    currency: null,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    perCustomerLimit: null,
    allComics: true,
    comicCount: 0,
    ...overrides,
  };
}

describe("couponShapeIssues", () => {
  it("accepts a plain percentage coupon", () => {
    expect(couponShapeIssues(shape())).toEqual([]);
  });

  describe("percentage coupons", () => {
    it("need a percentage between 0 (exclusive) and 100 (inclusive)", () => {
      expect(couponShapeIssues(shape({ percentOff: null }))).toHaveLength(1);
      expect(couponShapeIssues(shape({ percentOff: 0 }))).toHaveLength(1);
      expect(couponShapeIssues(shape({ percentOff: -5 }))).toHaveLength(1);
      expect(couponShapeIssues(shape({ percentOff: 100.01 }))).toHaveLength(1);
      expect(couponShapeIssues(shape({ percentOff: 100 }))).toEqual([]);
      expect(couponShapeIssues(shape({ percentOff: 0.01 }))).toEqual([]);
    });

    it("cannot also carry a fixed amount", () => {
      expect(couponShapeIssues(shape({ amountOff: 50 }))).toHaveLength(1);
    });

    it("need a currency only when they have a maximum discount", () => {
      expect(couponShapeIssues(shape({ maxDiscount: 300 }))).toHaveLength(1);
      expect(
        couponShapeIssues(shape({ maxDiscount: 300, currency: "INR" }))
      ).toEqual([]);
      expect(couponShapeIssues(shape({ currency: null }))).toEqual([]);
    });
  });

  describe("fixed coupons", () => {
    const fixed = (o: Partial<CouponShape> = {}) =>
      shape({
        discountType: "FIXED",
        percentOff: null,
        amountOff: 100,
        currency: "INR",
        ...o,
      });

    it("accept an amount in a currency", () => {
      expect(couponShapeIssues(fixed())).toEqual([]);
    });

    it("need an amount above zero", () => {
      expect(couponShapeIssues(fixed({ amountOff: null }))).toHaveLength(1);
      expect(couponShapeIssues(fixed({ amountOff: 0 }))).toHaveLength(1);
      expect(couponShapeIssues(fixed({ amountOff: -1 }))).toHaveLength(1);
    });

    it("need a currency", () => {
      expect(couponShapeIssues(fixed({ currency: null }))).toHaveLength(1);
    });

    it("cannot carry a percentage or a maximum discount", () => {
      expect(couponShapeIssues(fixed({ percentOff: 10 }))).toHaveLength(1);
      expect(couponShapeIssues(fixed({ maxDiscount: 50 }))).toHaveLength(1);
    });
  });

  it("requires a 3-letter upper-case currency code", () => {
    expect(
      couponShapeIssues(shape({ maxDiscount: 10, currency: "inr" }))
    ).toHaveLength(1);
    expect(
      couponShapeIssues(shape({ maxDiscount: 10, currency: "INDIA" }))
    ).toHaveLength(1);
    expect(
      couponShapeIssues(shape({ maxDiscount: 10, currency: "USD" }))
    ).toEqual([]);
  });

  it("rejects a non-positive maximum discount", () => {
    expect(
      couponShapeIssues(shape({ maxDiscount: 0, currency: "INR" }))
    ).toHaveLength(1);
  });

  describe("dates", () => {
    const start = new Date("2026-12-01T00:00:00.000Z");

    it("need the end strictly after the start", () => {
      expect(
        couponShapeIssues(
          shape({ startsAt: start, endsAt: new Date(start.getTime() + 1) })
        )
      ).toEqual([]);
      expect(
        couponShapeIssues(shape({ startsAt: start, endsAt: start }))
      ).toHaveLength(1);
      expect(
        couponShapeIssues(
          shape({ startsAt: start, endsAt: new Date(start.getTime() - 1) })
        )
      ).toHaveLength(1);
    });

    it("accept a start only, an end only, or neither", () => {
      expect(couponShapeIssues(shape({ startsAt: start }))).toEqual([]);
      expect(couponShapeIssues(shape({ endsAt: start }))).toEqual([]);
    });
  });

  it("requires at least one comic when the coupon is not for all comics", () => {
    expect(
      couponShapeIssues(shape({ allComics: false, comicCount: 0 }))
    ).toHaveLength(1);
    expect(
      couponShapeIssues(shape({ allComics: false, comicCount: 2 }))
    ).toEqual([]);
  });

  it("requires usage limits of at least 1 when set", () => {
    expect(couponShapeIssues(shape({ usageLimit: 0 }))).toHaveLength(1);
    expect(couponShapeIssues(shape({ perCustomerLimit: 0 }))).toHaveLength(1);
    expect(
      couponShapeIssues(shape({ usageLimit: 1, perCustomerLimit: 1 }))
    ).toEqual([]);
  });

  it("requires a single-use coupon to have a total limit of exactly 1", () => {
    expect(
      couponShapeIssues(shape({ kind: "SINGLE_USE", usageLimit: 1 }))
    ).toEqual([]);
    expect(
      couponShapeIssues(shape({ kind: "SINGLE_USE", usageLimit: null }))
    ).toHaveLength(1);
    expect(
      couponShapeIssues(shape({ kind: "SINGLE_USE", usageLimit: 5 }))
    ).toHaveLength(1);
  });

  it("reports every problem at once", () => {
    const issues = couponShapeIssues(
      shape({
        discountType: "FIXED",
        percentOff: 150,
        amountOff: null,
        allComics: false,
      })
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});
