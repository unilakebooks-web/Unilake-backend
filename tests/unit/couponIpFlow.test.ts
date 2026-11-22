import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  coupon: { findUnique: vi.fn() },
}));
const limiter = vi.hoisted(() => ({
  isCouponAttemptLimited: vi.fn(),
  recordFailedCouponAttempt: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/config/env.js", () => ({ config: {} }));
vi.mock("../../src/lib/razorpay.js", () => ({
  currencyExponent: () => 2,
  razorpay: {},
  toSmallestUnit: (n: number) => n * 100,
}));
vi.mock("../../src/services/session.service.js", () => ({}));
vi.mock("../../src/utils/attemptLimiter.js", () => limiter);
vi.mock("../../src/utils/keyedQueue.js", () => ({ acquireSlot: vi.fn() }));

import { Prisma } from "../../src/generated/prisma/client.js";
import { priceCoupon } from "../../src/services/couponCheckout.service.js";

const args = (extra: Record<string, unknown> = {}) => ({
  userId: "u1",
  rawCode: "NOSUCHCODE",
  comicId: "comic1",
  countryCode: "IN",
  coverType: "SOFTCOVER" as never,
  currency: "INR",
  listPrice: new Prisma.Decimal(1000),
  ...extra,
});

describe("priceCoupon and the caller's IP address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiter.isCouponAttemptLimited.mockResolvedValue(false);
    limiter.recordFailedCouponAttempt.mockResolvedValue(undefined);
    prismaMock.coupon.findUnique.mockResolvedValue(null);
  });

  it("asks the limiter about the account and the IP address", async () => {
    await expect(priceCoupon(args({ ip: "9.9.9.9" }))).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    expect(limiter.isCouponAttemptLimited).toHaveBeenCalledWith(
      "u1",
      "9.9.9.9"
    );
  });

  it("counts the failed attempt against the account and the IP address", async () => {
    await expect(priceCoupon(args({ ip: "9.9.9.9" }))).rejects.toBeDefined();
    expect(limiter.recordFailedCouponAttempt).toHaveBeenCalledWith(
      "u1",
      "9.9.9.9"
    );
  });

  it("refuses without looking the code up when the limiter says stop", async () => {
    limiter.isCouponAttemptLimited.mockResolvedValue(true);
    await expect(priceCoupon(args({ ip: "9.9.9.9" }))).rejects.toMatchObject({
      code: "COUPON_TOO_MANY_ATTEMPTS",
    });
    expect(prismaMock.coupon.findUnique).not.toHaveBeenCalled();
  });

  it("does not consult the limiter for a code the order already carries", async () => {
    await expect(
      priceCoupon(args({ ip: "9.9.9.9", skipAttemptLimit: true }))
    ).rejects.toBeDefined();
    expect(limiter.isCouponAttemptLimited).not.toHaveBeenCalled();
  });

  it("works as before when no IP address is known", async () => {
    await expect(priceCoupon(args())).rejects.toBeDefined();
    expect(limiter.isCouponAttemptLimited).toHaveBeenCalledWith(
      "u1",
      undefined
    );
    expect(limiter.recordFailedCouponAttempt).toHaveBeenCalledWith(
      "u1",
      undefined
    );
  });
});
