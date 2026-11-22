import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  coupon: { findUnique: vi.fn() },
  couponRedemption: { count: vi.fn(), upsert: vi.fn() },
  order: { findFirst: vi.fn() },
  $queryRaw: vi.fn(),
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
vi.mock("../../src/utils/attemptLimiter.js", () => ({
  isCouponAttemptLimited: vi.fn().mockResolvedValue(false),
  recordFailedCouponAttempt: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/utils/keyedQueue.js", () => ({ acquireSlot: vi.fn() }));

import { Prisma } from "../../src/generated/prisma/client.js";
import {
  priceCoupon,
  reserveCouponInTx,
} from "../../src/services/couponCheckout.service.js";
import { phoneKey } from "../../src/utils/phoneKey.js";
import { REVENUE_STATUSES } from "../../src/config/stats.js";

describe("phoneKey", () => {
  it("makes the same key for the usual ways of writing one number", () => {
    const keys = [
      "+91 99561 22575",
      "099561-22575",
      "9956122575",
      "(+91) 99561 22575",
    ].map(phoneKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("9956122575");
  });
  it("has no key for a missing or too short number", () => {
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey(undefined)).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey("12345")).toBeNull();
    expect(phoneKey("abc")).toBeNull();
  });
  it("has no key for filler numbers that many customers type", () => {
    expect(phoneKey("0000000000")).toBeNull();
    expect(phoneKey("9999999999")).toBeNull();
    expect(phoneKey("+91 1234567890")).toBeNull();
    expect(phoneKey("9876543210")).toBeNull();
  });
  it("tells two different numbers apart", () => {
    expect(phoneKey("9956122575")).not.toBe(phoneKey("9956122576"));
  });
});

function couponRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    code: "WELCOME",
    name: "Welcome",
    updatedAt: new Date("2026-11-20T00:00:00.000Z"),
    isActive: true,
    discountType: "PERCENT",
    percentOff: new Prisma.Decimal(10),
    amountOff: null,
    maxDiscount: null,
    currency: null,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    perCustomerLimit: null,
    restrictedToUserId: null,
    allComics: true,
    comics: [],
    countryCodes: [],
    coverTypes: [],
    firstOrderOnly: false,
    ...overrides,
  };
}

const args = (phone?: string | null) => ({
  userId: "u-new-account",
  rawCode: "WELCOME",
  comicId: "comic1",
  countryCode: "IN",
  coverType: "SOFTCOVER" as never,
  currency: "INR",
  listPrice: new Prisma.Decimal(1000),
  phone,
});

// The earlier order of the same customer, made on another account, is found by
// its phone number only; the new account has no use of its own.
function arrange(opts: {
  row: ReturnType<typeof couponRow>;
  earlierOrder: boolean;
}) {
  prismaMock.coupon.findUnique.mockResolvedValue(opts.row);
  prismaMock.$queryRaw.mockResolvedValue(
    opts.earlierOrder ? [{ id: "order-on-other-account" }] : []
  );
  prismaMock.couponRedemption.count.mockImplementation(
    async ({ where }: { where: { AND?: unknown } }) =>
      // total uses: 1 when the earlier order exists; this customer's own uses: only
      // seen when the query includes the phone-matched orders (the AND form)
      where.AND ? (opts.earlierOrder ? 1 : 0) : 0
  );
  prismaMock.order.findFirst.mockImplementation(
    async ({ where }: { where: { OR?: unknown } }) =>
      where.OR ? { id: "order-on-other-account" } : null
  );
}

describe("a coupon and the customer's other account", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a per-customer code already used on another account with the same phone", async () => {
    arrange({ row: couponRow({ perCustomerLimit: 1 }), earlierOrder: true });
    await expect(priceCoupon(args("+91 99561 22575"))).rejects.toMatchObject({
      code: "COUPON_ALREADY_USED",
    });
    const ownUses = prismaMock.couponRedemption.count.mock.calls
      .map(([call]) => call.where)
      .find((where: { AND?: unknown }) => where.AND) as {
      AND: [unknown, { OR: unknown[] }];
    };
    expect(ownUses.AND[1].OR).toEqual([
      { userId: "u-new-account" },
      { orderId: { in: ["order-on-other-account"] } },
    ]);
  });

  it("refuses a first-order-only code when another account with the same phone has paid", async () => {
    arrange({ row: couponRow({ firstOrderOnly: true }), earlierOrder: true });
    await expect(priceCoupon(args("9956122575"))).rejects.toMatchObject({
      code: "COUPON_FIRST_ORDER_ONLY",
    });
    const { where } = prismaMock.order.findFirst.mock.calls[0]![0];
    expect(where.OR).toEqual([
      { orderSession: { userId: "u-new-account" } },
      { id: { in: ["order-on-other-account"] } },
    ]);
    // Only paid orders make a later order "not the first".
    expect(where.status).toEqual({ in: REVENUE_STATUSES });
  });

  it("still accepts the code when no earlier order shares the phone", async () => {
    arrange({
      row: couponRow({ perCustomerLimit: 1, firstOrderOnly: true }),
      earlierOrder: false,
    });
    const priced = await priceCoupon(args("9956122575"));
    expect(priced.couponId).toBe("c1");
    expect(priced.phone).toBe("9956122575");
  });

  it("behaves as before, with no phone lookup, when there is no phone", async () => {
    arrange({
      row: couponRow({ perCustomerLimit: 1, firstOrderOnly: true }),
      earlierOrder: true,
    });
    const priced = await priceCoupon(args(null));
    expect(priced.couponId).toBe("c1");
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("does not compare a number that is too short", async () => {
    arrange({ row: couponRow({ perCustomerLimit: 1 }), earlierOrder: true });
    await priceCoupon(args("12345"));
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("the reservation re-checks the customer's other account under the lock", () => {
  beforeEach(() => vi.clearAllMocks());

  // Priced while no earlier order shared the phone; by reservation time another
  // account has used the code.
  async function pricedBeforeTheOtherAccountPays() {
    const row = couponRow({ perCustomerLimit: 1 });
    arrange({ row, earlierOrder: false });
    const priced = await priceCoupon(args("9956122575"));
    return { row, priced };
  }

  it("refuses when an order on the same phone used the code in the meantime", async () => {
    const { row, priced } = await pricedBeforeTheOtherAccountPays();
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ updatedAt: row.updatedAt }])
      .mockResolvedValueOnce([{ id: "order-on-other-account" }]);
    prismaMock.couponRedemption.count.mockImplementation(
      async ({ where }: { where: { AND?: unknown } }) => (where.AND ? 1 : 0)
    );
    await expect(
      reserveCouponInTx(prismaMock as never, {
        priced,
        orderId: "new-order",
        userId: "u-new-account",
      })
    ).rejects.toMatchObject({ code: "COUPON_ALREADY_USED" });
  });

  it("looks up no phone when the order was priced without one", async () => {
    const row = couponRow({ perCustomerLimit: 1 });
    arrange({ row, earlierOrder: false });
    const priced = await priceCoupon(args(null));
    prismaMock.$queryRaw.mockClear();
    prismaMock.$queryRaw.mockResolvedValueOnce([{ updatedAt: row.updatedAt }]);
    prismaMock.couponRedemption.count.mockResolvedValue(0);
    await reserveCouponInTx(prismaMock as never, {
      priced,
      orderId: "new-order",
      userId: "u-new-account",
    });
    // Only the row lock ran as a raw query.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
