import { describe, it, expect } from "vitest";
import {
  checkoutBodySchema,
  couponPreviewBodySchema,
} from "../../src/validators/checkout.schema.js";
import {
  COUPON_CODE_INPUT_MAX,
  COUPON_MESSAGES,
} from "../../src/config/coupon.js";

const tooLong = "A".repeat(COUPON_CODE_INPUT_MAX + 1);

describe("couponPreviewBodySchema", () => {
  it("accepts a code up to the input limit", () => {
    expect(
      couponPreviewBodySchema.safeParse({
        code: "A".repeat(COUPON_CODE_INPUT_MAX),
      }).success
    ).toBe(true);
  });

  it("answers an over-long code in customer language, not zod text", () => {
    const result = couponPreviewBodySchema.safeParse({ code: tooLong });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(COUPON_MESSAGES.INVALID);
    }
  });

  it("still asks for a code when it is empty", () => {
    const result = couponPreviewBodySchema.safeParse({ code: "  " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Enter a coupon code");
    }
  });
});

describe("checkoutBodySchema", () => {
  it("answers an over-long code in customer language, not zod text", () => {
    const result = checkoutBodySchema.safeParse({ couponCode: tooLong });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(COUPON_MESSAGES.INVALID);
    }
  });

  it("accepts no code, a code and null", () => {
    expect(checkoutBodySchema.safeParse({}).success).toBe(true);
    expect(
      checkoutBodySchema.safeParse({ couponCode: "SAVE-10" }).success
    ).toBe(true);
    expect(checkoutBodySchema.safeParse({ couponCode: null }).success).toBe(
      true
    );
  });
});
