import { describe, it, expect } from "vitest";
import {
  generateCouponCode,
  isValidCouponCode,
  normalizeCouponCode,
  parseValidityInput,
} from "../../src/utils/couponCode.js";
import { GENERATED_CODE_ALPHABET } from "../../src/config/coupon.js";

describe("normalizeCouponCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeCouponCode("  festive-25 ")).toBe("FESTIVE-25");
    expect(normalizeCouponCode("Diwali2026")).toBe("DIWALI2026");
  });

  it("leaves an empty or whitespace-only string empty", () => {
    expect(normalizeCouponCode("")).toBe("");
    expect(normalizeCouponCode("   ")).toBe("");
  });
});

describe("isValidCouponCode", () => {
  it("accepts 4 to 32 letters, digits and hyphens", () => {
    expect(isValidCouponCode("ABCD")).toBe(true);
    expect(isValidCouponCode("FESTIVE-25")).toBe(true);
    expect(isValidCouponCode("A".repeat(32))).toBe(true);
  });

  it("refuses too short, too long and empty codes", () => {
    expect(isValidCouponCode("ABC")).toBe(false);
    expect(isValidCouponCode("A".repeat(33))).toBe(false);
    expect(isValidCouponCode("")).toBe(false);
  });

  it("refuses spaces, other punctuation, lower case, unicode and markup", () => {
    for (const bad of [
      "FEST IVE",
      "FEST_IVE",
      "FEST.IVE",
      "festive",
      "FESTÍVE",
      "<B>HI</B>",
      "A'B--",
      "%27OR1=1",
    ]) {
      expect(isValidCouponCode(bad), bad).toBe(false);
    }
  });

  it("accepts a code only after normalization turns it upper-case", () => {
    expect(isValidCouponCode("festive-25")).toBe(false);
    expect(isValidCouponCode(normalizeCouponCode("festive-25"))).toBe(true);
  });
});

describe("generateCouponCode", () => {
  it("builds a code of the default length from the alphabet only", () => {
    const code = generateCouponCode((max) => Math.floor(Math.random() * max));
    expect(code).toHaveLength(8);
    for (const ch of code) expect(GENERATED_CODE_ALPHABET).toContain(ch);
    expect(isValidCouponCode(code)).toBe(true);
  });

  it("is deterministic for a given picker", () => {
    expect(generateCouponCode(() => 0)).toBe("AAAAAAAA");
    let n = 0;
    expect(generateCouponCode(() => n++, 4)).toBe("ABCD");
  });

  it("never uses the ambiguous characters 0, O, 1 or I", () => {
    expect(GENERATED_CODE_ALPHABET).not.toMatch(/[01OI]/);
    const all = generateCouponCode(
      (() => {
        let i = 0;
        return () => i++ % GENERATED_CODE_ALPHABET.length;
      })(),
      GENERATED_CODE_ALPHABET.length
    );
    expect(all).toBe(GENERATED_CODE_ALPHABET);
  });

  it("respects a custom length", () => {
    expect(generateCouponCode(() => 1, 12)).toHaveLength(12);
  });
});

describe("parseValidityInput", () => {
  it("reads a date-only start as midnight IST", () => {
    expect(parseValidityInput("2026-12-01", "start")?.toISOString()).toBe(
      "2026-11-30T18:30:00.000Z"
    );
  });

  it("reads a date-only end as the last millisecond of that day in IST", () => {
    expect(parseValidityInput("2026-12-31", "end")?.toISOString()).toBe(
      "2026-12-31T18:29:59.999Z"
    );
  });

  it("includes the whole last day: the end is after 23:59 IST and before the next IST day", () => {
    const end = parseValidityInput("2026-12-31", "end")!;
    expect(end.getTime()).toBeGreaterThan(
      new Date("2026-12-31T18:29:00.000Z").getTime()
    );
    expect(end.getTime()).toBeLessThan(
      new Date("2026-12-31T18:30:00.000Z").getTime()
    );
  });

  it("handles a leap day and year boundaries", () => {
    expect(parseValidityInput("2028-02-29", "start")).not.toBeNull();
    expect(parseValidityInput("2026-12-31", "start")?.toISOString()).toBe(
      "2026-12-30T18:30:00.000Z"
    );
    expect(parseValidityInput("2027-01-01", "start")?.toISOString()).toBe(
      "2026-12-31T18:30:00.000Z"
    );
  });

  it("refuses dates that do not exist", () => {
    expect(parseValidityInput("2026-02-30", "start")).toBeNull();
    expect(parseValidityInput("2027-02-29", "end")).toBeNull();
    expect(parseValidityInput("2026-13-01", "start")).toBeNull();
    expect(parseValidityInput("2026-00-10", "start")).toBeNull();
  });

  it("accepts a full date-time that carries an offset, unchanged", () => {
    expect(
      parseValidityInput("2026-12-31T10:00:00+05:30", "end")?.toISOString()
    ).toBe("2026-12-31T04:30:00.000Z");
    expect(
      parseValidityInput("2026-12-31T10:00:00Z", "start")?.toISOString()
    ).toBe("2026-12-31T10:00:00.000Z");
  });

  it("refuses an impossible date inside a full date-time too", () => {
    expect(parseValidityInput("2026-02-30T10:00:00+05:30", "end")).toBeNull();
  });

  it("refuses a date-time with no offset, because it is ambiguous", () => {
    expect(parseValidityInput("2026-12-31T10:00:00", "end")).toBeNull();
  });

  it("refuses garbage and empty input", () => {
    for (const bad of [
      "",
      "tomorrow",
      "31/12/2026",
      "2026-12-31 10:00",
      "2026-1-1",
    ]) {
      expect(parseValidityInput(bad, "start"), bad).toBeNull();
    }
  });

  it("trims surrounding whitespace", () => {
    expect(parseValidityInput("  2026-12-31  ", "end")).not.toBeNull();
  });
});
