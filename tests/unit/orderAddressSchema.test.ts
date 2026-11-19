// Request rules of the address edit: what the schemas accept and refuse, before the
// service applies the rules that depend on the order itself.
import { describe, expect, it } from "vitest";
import {
  editOrderAddressBodySchema,
  markAddressSyncedBodySchema,
} from "../../src/validators/order.schema.js";

const GOOD = {
  name: "Asha Kapoor",
  line1: "Flat 9, Sunrise Apartments",
  line2: "Opp. Garden",
  city: "Mumbai",
  state: "Maharashtra",
  zip: "400050",
  phone: "9123456780",
  expectedSeq: 0,
};

describe("editOrderAddressBodySchema", () => {
  it("accepts a normal address and trims it", () => {
    const r = editOrderAddressBodySchema.parse({
      ...GOOD,
      name: "  Asha Kapoor  ",
    });
    expect(r.name).toBe("Asha Kapoor");
  });

  it("line 2 is optional", () => {
    const { line2: _line2, ...without } = GOOD;
    expect(editOrderAddressBodySchema.safeParse(without).success).toBe(true);
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, line2: "" }).success
    ).toBe(true);
  });

  it("ignores a country sent in the body (it is not editable)", () => {
    const r = editOrderAddressBodySchema.parse({
      ...GOOD,
      country: "US",
      extra: 1,
    });
    expect(r).not.toHaveProperty("country");
    expect(r).not.toHaveProperty("extra");
  });

  it.each(["name", "line1", "city", "state", "zip", "phone"])(
    "refuses a missing or empty %s",
    (field) => {
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, [field]: "" }).success
      ).toBe(false);
      const copy: Record<string, unknown> = { ...GOOD };
      delete copy[field];
      expect(editOrderAddressBodySchema.safeParse(copy).success).toBe(false);
    }
  );

  it("refuses whitespace-only required fields", () => {
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, name: "   " }).success
    ).toBe(false);
  });

  it.each([
    ["name", 101],
    ["line1", 191],
    ["line2", 191],
    ["city", 41],
    ["state", 31],
  ])(
    "%s longer than Shiprocket's limit is refused, at the limit is accepted",
    (field, over) => {
      expect(
        editOrderAddressBodySchema.safeParse({
          ...GOOD,
          [field]: "a".repeat(over),
        }).success
      ).toBe(false);
      expect(
        editOrderAddressBodySchema.safeParse({
          ...GOOD,
          [field]: "a".repeat(over - 1),
        }).success
      ).toBe(true);
    }
  );

  it.each([
    "1e5",
    "0x10",
    " 123 4",
    "SW1A 1AA",
    "012345",
    "123",
    "12345678901",
    "+91400050",
  ])("refuses the pincode %j", (zip) => {
    expect(editOrderAddressBodySchema.safeParse({ ...GOOD, zip }).success).toBe(
      false
    );
  });

  it.each(["1234", "400050", "1234567890"])("accepts the pincode %j", (zip) => {
    expect(editOrderAddressBodySchema.safeParse({ ...GOOD, zip }).success).toBe(
      true
    );
  });

  it.each([
    "+91 98765 43210",
    "98765-43210",
    "1e10",
    "0x1234567",
    "123456",
    "1234567890123456",
    "98765 43210",
  ])("refuses the phone %j", (phone) => {
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, phone }).success
    ).toBe(false);
  });

  it.each(["1234567", "9123456780", "919123456780", "123456789012345"])(
    "accepts the phone %j",
    (phone) => {
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, phone }).success
      ).toBe(true);
    }
  );

  // Shiprocket's rules, found by trying each field on a real test order.
  it.each([
    "Asha Kapoor",
    "Iyer-Sundaramoorthy Rao",
    "Conor O'Brien",
    "Dr. Asha Kapoor",
    "Asha",
  ])("accepts the name %j", (name) => {
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, name }).success
    ).toBe(true);
  });

  it.each([
    "आरव शर्मा",
    "José Garcia",
    "Asha Kapoor 2",
    "Asha_Kapoor",
    "<b>x</b>",
    "Asha 🙂",
  ])(
    "refuses the name %j (English letters, spaces, dots, hyphens and apostrophes only)",
    (name) => {
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, name }).success
      ).toBe(false);
    }
  );

  it.each(["12 गांधी रोड", "12 Rue de la Café", "12 Main Road 🏠"])(
    "refuses the address line %j (English text only)",
    (line) => {
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, line1: line }).success
      ).toBe(false);
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, line2: line }).success
      ).toBe(false);
    }
  );

  it("accepts punctuation, digits and a line break in the address lines, and markup-like text as plain text", () => {
    const r = editOrderAddressBodySchema.parse({
      ...GOOD,
      line1: "Plot #12/B, Sector 4-A, Opp. St. Mary's, 2nd Floor",
      line2: "Near the park\nBehind <b>the</b> mall",
    });
    expect(r.line2).toContain("<b>");
  });

  it("the city and state may be in any script (Shiprocket accepts them)", () => {
    expect(
      editOrderAddressBodySchema.safeParse({
        ...GOOD,
        city: "पुणे",
        state: "महाराष्ट्र",
      }).success
    ).toBe(true);
  });

  it("needs expectedSeq, a whole number from 0", () => {
    const { expectedSeq: _e, ...without } = GOOD;
    expect(editOrderAddressBodySchema.safeParse(without).success).toBe(false);
    for (const expectedSeq of [-1, 1.5, "0"]) {
      expect(
        editOrderAddressBodySchema.safeParse({ ...GOOD, expectedSeq }).success
      ).toBe(false);
    }
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, expectedSeq: 7 }).success
    ).toBe(true);
  });

  it("a name that is not a string is refused", () => {
    expect(
      editOrderAddressBodySchema.safeParse({ ...GOOD, name: 5 }).success
    ).toBe(false);
  });
});

describe("markAddressSyncedBodySchema", () => {
  const OK = { note: "checked in the Shiprocket panel", upToSeq: 3 };

  it("accepts a note of 10 characters or more with the newest change seen", () => {
    expect(markAddressSyncedBodySchema.safeParse(OK).success).toBe(true);
    expect(
      markAddressSyncedBodySchema.safeParse({ ...OK, note: "0123456789" })
        .success
    ).toBe(true);
  });

  it("refuses a short note, an empty note, a note of spaces and a note over 500", () => {
    for (const note of ["short", "", "          ", "a".repeat(501)]) {
      expect(
        markAddressSyncedBodySchema.safeParse({ ...OK, note }).success
      ).toBe(false);
    }
  });

  it("needs a positive whole upToSeq", () => {
    for (const upToSeq of [undefined, 0, -1, 1.5, "3"]) {
      expect(
        markAddressSyncedBodySchema.safeParse({ ...OK, upToSeq }).success
      ).toBe(false);
    }
  });
});
