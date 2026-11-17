import { describe, it, expect } from "vitest";
import {
  couponStatusBodySchema,
  createCouponSchema,
  searchCustomersQuerySchema,
  listCouponsQuerySchema,
  updateCouponSchema,
} from "../../src/validators/coupon.schema.js";

const base = { name: "Festive offer", discountType: "PERCENT", percentOff: 20 };
const UUID = "11111111-1111-4111-8111-111111111111";

describe("coupon name and description limits", () => {
  const messages = (result: {
    success: boolean;
    error?: { issues: { message: string }[] };
  }) => result.error?.issues.map((i) => i.message) ?? [];

  it("gives plain messages on create", () => {
    expect(
      messages(createCouponSchema.safeParse({ ...base, name: "n".repeat(101) }))
    ).toContain("Name can be at most 100 characters");
    expect(
      messages(
        createCouponSchema.safeParse({ ...base, description: "d".repeat(501) })
      )
    ).toContain("Description can be at most 500 characters");
  });

  it("gives plain messages on update", () => {
    expect(
      messages(updateCouponSchema.safeParse({ name: "n".repeat(101) }))
    ).toContain("Name can be at most 100 characters");
    expect(
      messages(updateCouponSchema.safeParse({ description: "d".repeat(501) }))
    ).toContain("Description can be at most 500 characters");
  });
});

describe("createCouponSchema", () => {
  it("applies the defaults", () => {
    const parsed = createCouponSchema.parse(base);
    expect(parsed.kind).toBe("PUBLIC");
    expect(parsed.allComics).toBe(true);
    expect(parsed.comicIds).toEqual([]);
    expect(parsed.countryCodes).toEqual([]);
    expect(parsed.coverTypes).toEqual([]);
    expect(parsed.combinable).toBe(false);
    expect(parsed.showAtCheckout).toBe(false);
    expect(parsed.firstOrderOnly).toBe(false);
    expect(parsed.isActive).toBe(true);
    expect(parsed.code).toBeUndefined();
  });

  it("reads showAtCheckout and rejects a non-boolean", () => {
    expect(
      createCouponSchema.parse({ ...base, showAtCheckout: true }).showAtCheckout
    ).toBe(true);
    expect(
      createCouponSchema.safeParse({ ...base, showAtCheckout: "yes" }).success
    ).toBe(false);
    expect(
      updateCouponSchema.parse({ showAtCheckout: false }).showAtCheckout
    ).toBe(false);
    expect(updateCouponSchema.parse({ name: "x" }).showAtCheckout).toBe(
      undefined
    );
  });

  it("reads firstOrderOnly and rejects a non-boolean", () => {
    expect(
      createCouponSchema.parse({ ...base, firstOrderOnly: true }).firstOrderOnly
    ).toBe(true);
    expect(
      createCouponSchema.safeParse({ ...base, firstOrderOnly: "yes" }).success
    ).toBe(false);
    expect(
      updateCouponSchema.parse({ firstOrderOnly: false }).firstOrderOnly
    ).toBe(false);
    expect(updateCouponSchema.parse({ name: "x" }).firstOrderOnly).toBe(
      undefined
    );
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

describe("column size limits", () => {
  const message = (data: object) => {
    const result = createCouponSchema.safeParse({ ...base, ...data });
    return result.success ? null : result.error.issues[0]?.message;
  };

  it("accepts the largest amount and refuses one cent more, with a plain message", () => {
    const fixed = { discountType: "FIXED", percentOff: undefined };
    expect(
      createCouponSchema.safeParse({
        ...base,
        ...fixed,
        amountOff: 99999999.99,
      }).success
    ).toBe(true);
    expect(message({ ...fixed, amountOff: 100000000 })).toBe(
      "Amount cannot be more than 99,999,999.99"
    );
    expect(message({ ...fixed, amountOff: 1000000000 })).toBe(
      "Amount cannot be more than 99,999,999.99"
    );
  });

  it("applies the same limit to the maximum discount", () => {
    expect(
      createCouponSchema.safeParse({ ...base, maxDiscount: 99999999.99 })
        .success
    ).toBe(true);
    expect(message({ maxDiscount: 1e12 })).toBe(
      "Maximum discount cannot be more than 99,999,999.99"
    );
  });

  it("accepts a limit of 2,147,483,647 and refuses one more", () => {
    for (const field of ["usageLimit", "perCustomerLimit"]) {
      expect(
        createCouponSchema.safeParse({ ...base, [field]: 2147483647 }).success,
        field
      ).toBe(true);
      expect(message({ [field]: 2147483648 }), field).toBe(
        "Limit cannot be more than 2,147,483,647"
      );
    }
  });

  it("applies the same limits on update", () => {
    expect(updateCouponSchema.safeParse({ amountOff: 100000000 }).success).toBe(
      false
    );
    expect(
      updateCouponSchema.safeParse({ usageLimit: 2147483648 }).success
    ).toBe(false);
    expect(
      updateCouponSchema.safeParse({ usageLimit: 2147483647 }).success
    ).toBe(true);
  });
});

describe("countries and cover types", () => {
  it("drops repeats and keeps the order", () => {
    const parsed = createCouponSchema.parse({
      ...base,
      countryCodes: ["us", "IN", "US", "in"],
      coverTypes: ["HARDCOVER", "HARDCOVER"],
    });
    expect(parsed.countryCodes).toEqual(["US", "IN"]);
    expect(parsed.coverTypes).toEqual(["HARDCOVER"]);
    expect(
      updateCouponSchema.parse({ countryCodes: ["IN", "IN"] }).countryCodes
    ).toEqual(["IN"]);
  });

  it("caps the lists at 250 countries and 2 cover types", () => {
    const codes = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        String.fromCharCode(65 + (Math.floor(i / 26) % 26), 65 + (i % 26))
      );
    expect(
      createCouponSchema.safeParse({ ...base, countryCodes: codes(250) })
        .success
    ).toBe(true);
    expect(
      createCouponSchema.safeParse({ ...base, countryCodes: codes(251) })
        .success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({
        ...base,
        countryCodes: Array(5000).fill("US"),
      }).success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({
        ...base,
        coverTypes: ["HARDCOVER", "SOFTCOVER", "HARDCOVER"],
      }).success
    ).toBe(false);
  });
});

describe("validity years", () => {
  it("refuses a start or end outside 2000 to 2100", () => {
    expect(
      createCouponSchema.safeParse({ ...base, endsAt: "9999-12-31" }).success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({ ...base, startsAt: "1999-12-31" }).success
    ).toBe(false);
    expect(
      createCouponSchema.safeParse({ ...base, endsAt: "2100-12-31" }).success
    ).toBe(true);
    expect(updateCouponSchema.safeParse({ endsAt: "9999-01-01" }).success).toBe(
      false
    );
  });
});

describe("couponStatusBodySchema", () => {
  it("accepts no field, true or false, and refuses anything else", () => {
    expect(couponStatusBodySchema.parse({})).toEqual({});
    expect(couponStatusBodySchema.parse({ isActive: false })).toEqual({
      isActive: false,
    });
    expect(couponStatusBodySchema.parse({ isActive: true })).toEqual({
      isActive: true,
    });
    for (const isActive of ["false", 0, 1, null]) {
      expect(
        couponStatusBodySchema.safeParse({ isActive }).success,
        String(isActive)
      ).toBe(false);
    }
  });
});
