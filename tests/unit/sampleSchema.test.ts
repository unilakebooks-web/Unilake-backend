import { describe, expect, it } from "vitest";
import {
  createSampleBodySchema,
  sampleSelectionsBodySchema,
} from "../../src/validators/sample.schema.js";
import { MAX_SAMPLE_PAGES } from "../../src/config/sample.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ok = {
  comicId: uuid(1),
  childName: "Aarav",
  age: 6,
  pronounKey: "HE",
  pageIds: [uuid(2)],
};
const pass = (o: object) =>
  createSampleBodySchema.safeParse({ ...ok, ...o }).success;

describe("createSampleBodySchema", () => {
  it("accepts a normal request, a Devanagari name, and the age bounds", () => {
    expect(pass({})).toBe(true);
    expect(pass({ childName: "आरव" })).toBe(true);
    expect(pass({ age: 0 })).toBe(true);
    expect(pass({ age: 18 })).toBe(true);
  });

  it("rejects an empty or blank name, a name over 50 characters, and a missing name", () => {
    expect(pass({ childName: "" })).toBe(false);
    expect(pass({ childName: "   " })).toBe(false);
    expect(pass({ childName: "a".repeat(51) })).toBe(false);
    expect(
      createSampleBodySchema.safeParse({ ...ok, childName: undefined }).success
    ).toBe(false);
  });

  it("keeps markup as plain text (escaping happens where it is shown)", () => {
    const parsed = createSampleBodySchema.parse({
      ...ok,
      childName: "<b>x</b>",
    });
    expect(parsed.childName).toBe("<b>x</b>");
  });

  it("rejects ages that are negative, over 18, fractional or not numbers", () => {
    for (const age of [-1, 19, 200, 5.5, "6", null])
      expect(pass({ age })).toBe(false);
  });

  it("accepts only HE or SHE", () => {
    expect(pass({ pronounKey: "SHE" })).toBe(true);
    for (const p of ["THEY", "he", "", null])
      expect(pass({ pronounKey: p })).toBe(false);
  });

  it("limits the pages: at least one, at most the cap, valid ids", () => {
    expect(pass({ pageIds: [] })).toBe(false);
    const many = Array.from({ length: MAX_SAMPLE_PAGES }, (_, i) =>
      uuid(i + 10)
    );
    expect(pass({ pageIds: many })).toBe(true);
    expect(pass({ pageIds: [...many, uuid(99)] })).toBe(false);
    expect(pass({ pageIds: ["not-a-uuid"] })).toBe(false);
    expect(pass({ comicId: "x" })).toBe(false);
  });
});

describe("sampleSelectionsBodySchema", () => {
  const sel = (i: number) => ({
    pageId: uuid(i),
    pageVersionId: uuid(i + 100),
  });
  it("needs 1 to the cap selections with valid ids", () => {
    expect(
      sampleSelectionsBodySchema.safeParse({ selections: [] }).success
    ).toBe(false);
    expect(
      sampleSelectionsBodySchema.safeParse({ selections: [sel(1)] }).success
    ).toBe(true);
    const tooMany = Array.from({ length: MAX_SAMPLE_PAGES + 1 }, (_, i) =>
      sel(i + 1)
    );
    expect(
      sampleSelectionsBodySchema.safeParse({ selections: tooMany }).success
    ).toBe(false);
    expect(
      sampleSelectionsBodySchema.safeParse({
        selections: [{ pageId: "x", pageVersionId: "y" }],
      }).success
    ).toBe(false);
  });
});
