import { describe, it, expect } from "vitest";
import {
  createCouponSchema,
  searchCustomersQuerySchema,
  listCouponsQuerySchema,
  updateCouponSchema,
} from "../../src/validators/coupon.schema.js";

const base = { name: "Festive offer", discountType: "PERCENT", percentOff: 20 };
const UUID = "11111111-1111-4111-8111-111111111111";

describe("createCouponSchema", () => {
  it("applies the defaults", () => {
    const parsed = createCouponSchema.parse(base);
    expect(parsed.kind).toBe("PUBLIC");
    expect(parsed.allComics).toBe(true);
    expect(parsed.comicIds).toEqual([]);
    expect(parsed.countryCodes).toEqual([]);
    expect(parsed.coverTypes).toEqual([]);
    expect(parsed.combinable).toBe(false);
    expect(parsed.isActive).toBe(true);
    expect(parsed.code).toBeUndefined();
  });

  it("normalises the code to upper case and trims it", () => {
    expect(
      createCouponSchema.parse({ ...base, code: "  festive-25 " }).code
    ).toBe("FESTIVE-25");
  });

  it("rejects badly formed codes", () => {
    for (const code of [
      "abc",
      "x".repeat(33),
      "BAD CODE",
      "BAD_CODE",
      "BÄD-CODE",
      "<b>",
    ]) {
      expect(
        createCouponSchema.safeParse({ ...base, code }).success,
        code
      ).toBe(false);
    }
  });

  it("rejects an empty or over-long name and description", () => {
    expect(createCouponSchema.safeParse({ ...base, name: "   " }).success).toBe(
      false
    );
    expect(
      createCouponSchema.safeParse({ ...base, name: "n".repeat(101) }).success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({ ...base, description: "d".repeat(501) })
        .success
    ).toBe(false);
  });

  it("rejects non-positive numbers and more than two decimals", () => {
    for (const percentOff of [0, -5, 12.345, "20"]) {
      expect(
        createCouponSchema.safeParse({ ...base, percentOff }).success,
        String(percentOff)
      ).toBe(false);
    }
    expect(
      createCouponSchema.safeParse({ ...base, percentOff: 12.5 }).success
    ).toBe(true);
    expect(
      createCouponSchema.safeParse({ ...base, percentOff: 33.33 }).success
    ).toBe(true);
  });

  it("rejects limits that are not whole numbers of at least 1", () => {
    for (const usageLimit of [0, -1, 1.5, "5"]) {
      expect(
        createCouponSchema.safeParse({ ...base, usageLimit }).success,
        String(usageLimit)
      ).toBe(false);
    }
    expect(
      createCouponSchema.safeParse({
        ...base,
        usageLimit: 100,
        perCustomerLimit: 1,
      }).success
    ).toBe(true);
  });

  describe("dates", () => {
    it("reads date-only values in IST", () => {
      const parsed = createCouponSchema.parse({
        ...base,
        startsAt: "2026-12-01",
        endsAt: "2026-12-31",
      });
      expect(parsed.startsAt?.toISOString()).toBe("2026-11-30T18:30:00.000Z");
      expect(parsed.endsAt?.toISOString()).toBe("2026-12-31T18:29:59.999Z");
    });

    it("rejects impossible dates and date-times without an offset", () => {
      expect(
        createCouponSchema.safeParse({ ...base, endsAt: "2026-02-30" }).success
      ).toBe(false);
      expect(
        createCouponSchema.safeParse({ ...base, endsAt: "2026-12-31T10:00:00" })
          .success
      ).toBe(false);
      expect(
        createCouponSchema.safeParse({ ...base, endsAt: "tomorrow" }).success
      ).toBe(false);
    });
  });

  it("upper-cases country codes and rejects anything that is not two letters", () => {
    expect(
      createCouponSchema.parse({ ...base, countryCodes: ["in", " us "] })
        .countryCodes
    ).toEqual(["IN", "US"]);
    expect(
      createCouponSchema.safeParse({ ...base, countryCodes: ["IND"] }).success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({ ...base, countryCodes: ["1N"] }).success
    ).toBe(false);
  });

  it("upper-cases the currency and rejects anything that is not three letters", () => {
    expect(
      createCouponSchema.parse({ ...base, currency: "inr" }).currency
    ).toBe("INR");
    expect(
      createCouponSchema.safeParse({ ...base, currency: "RUPEE" }).success
    ).toBe(false);
  });

  it("accepts only known cover types, discount types and kinds", () => {
    expect(
      createCouponSchema.safeParse({ ...base, coverTypes: ["PAPERBACK"] })
        .success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({ ...base, discountType: "BOGO" }).success
    ).toBe(false);
    expect(createCouponSchema.safeParse({ ...base, kind: "VIP" }).success).toBe(
      false
    );
  });

  it("requires comic ids to be UUIDs", () => {
    expect(
      createCouponSchema.safeParse({
        ...base,
        allComics: false,
        comicIds: [UUID],
      }).success
    ).toBe(true);
    expect(
      createCouponSchema.safeParse({
        ...base,
        allComics: false,
        comicIds: ["comic-1"],
      }).success
    ).toBe(false);
  });

  it("does not coerce strings into booleans", () => {
    expect(
      createCouponSchema.safeParse({ ...base, isActive: "false" }).success
    ).toBe(false);
  });
});

describe("updateCouponSchema", () => {
  it("rejects an empty update", () => {
    expect(updateCouponSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a single field", () => {
    expect(updateCouponSchema.safeParse({ name: "Renamed" }).success).toBe(
      true
    );
  });

  it("lets optional fields be cleared with null", () => {
    const parsed = updateCouponSchema.parse({
      endsAt: null,
      usageLimit: null,
      maxDiscount: null,
      currency: null,
      description: null,
      restrictedToUserId: null,
    });
    expect(parsed.endsAt).toBeNull();
    expect(parsed.usageLimit).toBeNull();
  });

  it("does not let required fields be cleared", () => {
    expect(updateCouponSchema.safeParse({ name: null }).success).toBe(false);
    expect(updateCouponSchema.safeParse({ discountType: null }).success).toBe(
      false
    );
  });

  it("applies the same per-field rules as create", () => {
    expect(updateCouponSchema.safeParse({ code: "x" }).success).toBe(false);
    expect(updateCouponSchema.safeParse({ percentOff: 0 }).success).toBe(false);
    expect(updateCouponSchema.parse({ code: "new-code-1" }).code).toBe(
      "NEW-CODE-1"
    );
  });
});

describe("code length", () => {
  it("accepts a length from 4 to 32 and leaves it out by default", () => {
    expect(createCouponSchema.parse(base)).not.toHaveProperty("codeLength");
    for (const codeLength of [4, 8, 32]) {
      expect(
        createCouponSchema.safeParse({ ...base, codeLength }).success,
        String(codeLength)
      ).toBe(true);
    }
  });

  it("rejects a length below 4, above 32, or not a whole number", () => {
    for (const codeLength of [0, 3, 33, 8.5, -1, "8"]) {
      expect(
        createCouponSchema.safeParse({ ...base, codeLength }).success,
        String(codeLength)
      ).toBe(false);
    }
  });
});

describe("searchCustomersQuerySchema", () => {
  it("needs at least two characters and trims the text", () => {
    expect(searchCustomersQuerySchema.safeParse({ search: "a" }).success).toBe(
      false
    );
    expect(searchCustomersQuerySchema.safeParse({}).success).toBe(false);
    expect(searchCustomersQuerySchema.parse({ search: "  ab " }).search).toBe(
      "ab"
    );
  });
});

describe("listCouponsQuerySchema", () => {
  it("defaults to page 1 with 20 per page", () => {
    expect(listCouponsQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 20,
    });
  });

  it("coerces numbers from query strings and caps the page size", () => {
    expect(
      listCouponsQuerySchema.parse({ page: "3", pageSize: "50" })
    ).toMatchObject({ page: 3, pageSize: 50 });
    expect(listCouponsQuerySchema.safeParse({ pageSize: "101" }).success).toBe(
      false
    );
    expect(listCouponsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });

  it("accepts only known status and kind filters", () => {
    expect(
      listCouponsQuerySchema.safeParse({ status: "active", kind: "SINGLE_USE" })
        .success
    ).toBe(true);
    expect(listCouponsQuerySchema.safeParse({ status: "maybe" }).success).toBe(
      false
    );
  });

  it("trims the search and rejects an empty one", () => {
    expect(listCouponsQuerySchema.parse({ search: "  fest " }).search).toBe(
      "fest"
    );
    expect(listCouponsQuerySchema.safeParse({ search: "   " }).success).toBe(
      false
    );
  });
});
