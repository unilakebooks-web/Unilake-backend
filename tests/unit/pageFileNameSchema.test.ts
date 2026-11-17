// Unit tests for the cleaner of the original file names stored for a page's
// artwork and mask. No database is needed.
import { describe, expect, it } from "vitest";
import {
  createPageSchema,
  updatePageSchema,
} from "../../src/validators/page.schema.js";

describe("the page file name cleaner", () => {
  const segments = (value: string | undefined) =>
    Array.from(new Intl.Segmenter().segment(value ?? "")).length;
  const parse = (name: unknown) =>
    createPageSchema.parse({ pageNumber: 1, artworkFileName: name })
      .artworkFileName;

  it("removes control characters including NUL and trims", () => {
    expect(parse("  a\u0000b\u0007c\n  ")).toBe("abc");
  });

  it("cuts at 255 visible characters: 255 stay, 256 are cut", () => {
    expect(segments(parse("x".repeat(255)))).toBe(255);
    expect(segments(parse("x".repeat(256)))).toBe(255);
    expect(segments(parse("x".repeat(400)))).toBe(255);
  });

  it("shortens a run of combining marks that counts as one visible character", () => {
    const flood = "a" + "\u0301".repeat(90000);
    const value = parse(flood) ?? "";
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.startsWith("a")).toBe(true);
  });

  it("never splits an emoji or a Hindi conjunct at the cut", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(parse("x".repeat(255) + family)).toBe("x".repeat(255));
    expect(parse("x".repeat(254) + family)).toBe("x".repeat(254) + family);
    const hindi = parse("\u092A\u0943\u0937\u094D\u0920".repeat(200)) ?? "";
    expect(segments(hindi)).toBe(255);
    // Re-cutting the result changes nothing, so no visible character was split.
    expect(parse(hindi)).toBe(hindi);
  });

  it("treats a value that is not a string as no name instead of failing", () => {
    for (const bad of [null, 12, true, {}, ["a"]]) {
      expect(parse(bad)).toBeUndefined();
    }
    expect(
      updatePageSchema.parse({ hasFace: true, artworkFileName: null })
    ).toEqual({
      hasFace: true,
      artworkFileName: undefined,
    });
  });

  it("replaces a lone surrogate so the value can always be stored", () => {
    const value = parse("bad\ud800name.png") ?? "";
    expect(value.isWellFormed()).toBe(true);
    expect(value.startsWith("bad")).toBe(true);
  });

  it("removes bidi overrides and zero-width spaces but keeps joiners", () => {
    expect(parse("ab\u202Egpj\u200B.png")).toBe("abgpj.png");
    expect(parse("a\u200Eb\u200Fc\u2028d\u00ADe\u2060f")).toBe("abcdef");
    expect(parse("a\u200Db")).toBe("a\u200Db");
  });

  it("treats an empty or whitespace-only name as no name", () => {
    expect(parse("  \n ")).toBeUndefined();
    expect(
      updatePageSchema.parse({ artworkFileName: "" }).artworkFileName
    ).toBeUndefined();
  });

  it("keeps a name that looks like markup as plain text", () => {
    expect(parse(`<img src=x onerror=alert(1)>.png`)).toBe(
      `<img src=x onerror=alert(1)>.png`
    );
  });
});
