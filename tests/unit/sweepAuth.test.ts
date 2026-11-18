import { describe, it, expect } from "vitest";
import {
  isValidSweepSecret,
  normalizeSweepSecret,
} from "../../src/utils/sweepAuth.js";

describe("isValidSweepSecret", () => {
  it("accepts exactly the configured secret", () => {
    expect(isValidSweepSecret("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("refuses everything when no secret is configured, even an empty header", () => {
    expect(isValidSweepSecret("", "")).toBe(false);
    expect(isValidSweepSecret(undefined, "")).toBe(false);
    expect(isValidSweepSecret("anything", "")).toBe(false);
  });

  it("refuses a missing or empty header", () => {
    expect(isValidSweepSecret(undefined, "s3cret-value")).toBe(false);
    expect(isValidSweepSecret("", "s3cret-value")).toBe(false);
  });

  it("refuses a wrong secret, a prefix of it and a longer one", () => {
    expect(isValidSweepSecret("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(isValidSweepSecret("s3cret", "s3cret-value")).toBe(false);
    expect(isValidSweepSecret("s3cret-value-and-more", "s3cret-value")).toBe(
      false
    );
  });

  it("is case sensitive", () => {
    expect(isValidSweepSecret("S3CRET-VALUE", "s3cret-value")).toBe(false);
  });
});

describe("normalizeSweepSecret", () => {
  it("keeps a secret of 16 or more characters and drops surrounding whitespace and a trailing newline", () => {
    expect(normalizeSweepSecret("a".repeat(16))).toBe("a".repeat(16));
    expect(normalizeSweepSecret("  " + "b".repeat(20) + "\n")).toBe(
      "b".repeat(20)
    );
  });

  it("treats unset, empty, whitespace-only and too short values as not configured", () => {
    expect(normalizeSweepSecret(undefined)).toBe("");
    expect(normalizeSweepSecret("")).toBe("");
    expect(normalizeSweepSecret("   \n")).toBe("");
    expect(normalizeSweepSecret("a".repeat(15))).toBe("");
    expect(normalizeSweepSecret("  " + "c".repeat(15) + "  ")).toBe("");
  });
});
