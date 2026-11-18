import { describe, it, expect } from "vitest";
import { isValidSweepSecret } from "../../src/utils/sweepAuth.js";

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
