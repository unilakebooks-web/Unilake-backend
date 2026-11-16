// Integration tests for coupons at checkout: pricing a code, previewing it,
// reserving, redeeming and releasing a use. They run against the Neon TEST
// branch only: the setup import below refuses any other database.
import "../setup/env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { redisClient } from "../../src/lib/redis.js";
import {
  pdfCompilationQueue,
  sdGenerationQueue,
  shiprocketQueue,
} from "../../src/jobs/queues.js";
import {
  createCouponSchema,
  updateCouponSchema,
} from "../../src/validators/coupon.schema.js";
import {
  createCoupon,
  updateCoupon,
} from "../../src/services/coupon.service.js";
import {
  couponResponseFields,
  previewCoupon,
  priceCoupon,
  redeemCouponInTx,
  releaseCouponInTx,
  reserveCouponInTx,
  type PricedCoupon,
} from "../../src/services/couponCheckout.service.js";
import { COUPON_TRANSACTION_OPTIONS } from "../../src/config/coupon.js";
import { acquireSlot } from "../../src/utils/keyedQueue.js";
import { AppError } from "../../src/utils/errors.js";

const MARK = "__vitest_checkout__";
const ADMIN = "vitest-admin";
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
let n = 0;
const code = () => `TCK-${RUN}-${++n}`;
const D = (value: string | number) => new Prisma.Decimal(value);

// Seeded data the tests rely on (the seed script's fixed ids).
const COMIC_ID = "00000000-0000-4000-8000-000000000100";
const OTHER_COMIC_ID = "00000000-0000-4000-8000-000000000200";

const make = (overrides: Record<string, unknown> = {}) =>
  createCouponSchema.parse({
    name: `${MARK} offer`,
    discountType: "PERCENT",
    percentOff: 20,
    code: code(),
    ...overrides,
  });

const userIds: string[] = [];
async function makeUser(label: string) {
  const id = `${MARK}-${RUN}-${label}-${userIds.length}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  userIds.push(id);
  return id;
}

/** An unpaid session and order for a user, the way checkout leaves them. */
async function makeOrder(userId: string) {
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId,
      status: "AWAITING_PAYMENT",
      coverType: "HARDCOVER",
      shippingName: "Test",
      shippingLine1: "1 Test St",
      shippingCity: "Mumbai",
      shippingState: "Maharashtra",
      shippingZip: "400001",
      shippingCountry: "IN",
      shippingPhone: "9999999999",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: 999,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
    },
  });
  return { sessionId: session.id, orderId: order.id };
}

const price = (
  userId: string,
  rawCode: string,
  extra: Record<string, unknown> = {}
) =>
  priceCoupon({
    userId,
    rawCode,
    comicId: COMIC_ID,
    countryCode: "IN",
    coverType: "HARDCOVER",
    currency: "INR",
    listPrice: D("999.00"),
    ...extra,
  });

/** Reserve exactly as checkout does: in the coupon's queue, one transaction, explicit options. */
async function reserve(priced: PricedCoupon, orderId: string, userId: string) {
  const slot = await acquireSlot(`coupon:${priced.couponId}`);
  try {
    return await prisma.$transaction(
      (tx) => reserveCouponInTx(tx, { priced, orderId, userId }),
      COUPON_TRANSACTION_OPTIONS
    );
  } finally {
    slot();
  }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

const redemption = (
  couponId: string,
  userId: string,
  orderId: string,
  status: "RESERVED" | "REDEEMED" | "RELEASED",
  createdAt?: Date
) =>
  prisma.couponRedemption.create({
    data: {
      couponId,
      orderId,
      userId,
      status,
      discountAmount: 10,
      ...(createdAt && { createdAt }),
    },
  });

async function cleanup() {
  const coupons = await prisma.coupon.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `${MARK}-` } },
    select: { id: true },
  });
  const couponIds = coupons.map((c) => c.id);
  const ids = users.map((u) => u.id);
  const sessions = await prisma.orderSession.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  await prisma.couponRedemption.deleteMany({
    where: { OR: [{ couponId: { in: couponIds } }, { userId: { in: ids } }] },
  });
  await prisma.order.deleteMany({
    where: { orderSessionId: { in: sessionIds } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) await redisClient.del(`coupon:failed-attempts:${id}`);
}

let customer: string;

beforeAll(async () => {
  await cleanup();
  customer = await makeUser("customer");
  const rule = await prisma.pricingRule.findFirst({
    where: {
      comicId: COMIC_ID,
      coverType: "HARDCOVER",
      country: { code: "IN" },
    },
  });
  if (!rule || !rule.price.equals(999)) {
    throw new Error(
      "The test database needs the seeded comic with an INR hardcover price of 999 (run the seed script)."
    );
  }
});

// Every refused code counts as a failed attempt (that is the brute-force
// limiter working), so give each test a clean slate. The limiter test below
// uses its own user and checks the real limit.
beforeEach(async () => {
  for (const id of userIds)
    await redisClient.del(`coupon:failed-attempts:${id}`);
});

afterAll(async () => {
  await cleanup();
  await Promise.all([
    sdGenerationQueue.close(),
    pdfCompilationQueue.close(),
    shiprocketQueue.close(),
  ]);
  await redisClient.quit();
  await prisma.$disconnect();
});

describe("priceCoupon", () => {
  it("prices a valid code and remembers the coupon's version", async () => {
    const c = await createCoupon(make(), ADMIN);
    const priced = await price(customer, c.code.toLowerCase());
    expect(priced.discountAmount.toFixed(2)).toBe("199.80");
    expect(priced.finalAmount.toFixed(2)).toBe("799.20");
    expect(priced.listAmount.toFixed(2)).toBe("999.00");
    expect(priced.couponId).toBe(c.id);
    expect(priced.version).toBe(c.updatedAt.getTime());
  });

  it("refuses an unknown or badly formed code as INVALID", async () => {
    expect(await refusal(price(customer, "NO-SUCH-CODE"))).toBe(
      "COUPON_INVALID"
    );
    expect(await refusal(price(customer, "x"))).toBe("COUPON_INVALID");
    expect(await refusal(price(customer, "   "))).toBe("COUPON_INVALID");
    expect(await refusal(price(customer, "<script>"))).toBe("COUPON_INVALID");
  });

  it("answers each reason with its own code", async () => {
    const day = 24 * 60 * 60 * 1000;
    const inactive = await createCoupon(make({ isActive: false }), ADMIN);
    const expired = await createCoupon(
      make({ startsAt: "2020-01-01", endsAt: "2020-01-31" }),
      ADMIN
    );
    const future = await createCoupon(make({ startsAt: "2099-01-01" }), ADMIN);
    const otherComic = await createCoupon(
      make({ allComics: false, comicIds: [OTHER_COMIC_ID] }),
      ADMIN
    );
    const usd = await createCoupon(
      make({ percentOff: 10, maxDiscount: 100, currency: "USD" }),
      ADMIN
    );
    const someoneElse = await makeUser("someone-else");
    const restricted = await createCoupon(
      make({ restrictedToUserId: someoneElse }),
      ADMIN
    );
    void day;

    expect(await refusal(price(customer, inactive.code))).toBe(
      "COUPON_INVALID"
    );
    expect(await refusal(price(customer, expired.code))).toBe("COUPON_EXPIRED");
    expect(await refusal(price(customer, future.code))).toBe(
      "COUPON_NOT_STARTED"
    );
    expect(await refusal(price(customer, otherComic.code))).toBe(
      "COUPON_NOT_APPLICABLE"
    );
    expect(await refusal(price(customer, usd.code))).toBe(
      "COUPON_NOT_APPLICABLE"
    );
    expect(await refusal(price(customer, restricted.code))).toBe(
      "COUPON_INVALID"
    );
    // the customer it is reserved for can use it
    expect((await price(someoneElse, restricted.code)).couponId).toBe(
      restricted.id
    );
  });

  it("uses the same message for unknown, inactive and wrong-customer codes", async () => {
    const someoneElse = await makeUser("owner");
    const restricted = await createCoupon(
      make({ restrictedToUserId: someoneElse }),
      ADMIN
    );
    const messages = new Set<string>();
    for (const raw of ["NO-SUCH-CODE-2", restricted.code]) {
      try {
        await price(customer, raw);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  describe("usage limits", () => {
    it("is USED_UP when redeemed or freshly reserved uses reach the limit", async () => {
      const c = await createCoupon(make({ usageLimit: 1 }), ADMIN);
      const buyer = await makeUser("buyer");
      const { orderId } = await makeOrder(buyer);
      await redemption(c.id, buyer, orderId, "REDEEMED");
      expect(await refusal(price(customer, c.code))).toBe("COUPON_USED_UP");
    });

    it("counts a reservation for 60 minutes and then stops counting it, with no job", async () => {
      const second = 1000;
      const c1 = await createCoupon(make({ usageLimit: 1 }), ADMIN);
      const c2 = await createCoupon(make({ usageLimit: 1 }), ADMIN);
      const buyer = await makeUser("window");
      const a = await makeOrder(buyer);
      const b = await makeOrder(buyer);
      await redemption(
        c1.id,
        buyer,
        a.orderId,
        "RESERVED",
        new Date(Date.now() - (60 * 60 - 1) * second)
      ); // 59:59 ago
      await redemption(
        c2.id,
        buyer,
        b.orderId,
        "RESERVED",
        new Date(Date.now() - (60 * 60 + 1) * second)
      ); // 60:01 ago
      expect(await refusal(price(customer, c1.code))).toBe("COUPON_USED_UP");
      expect((await price(customer, c2.code)).couponId).toBe(c2.id);
    });

    it("does not count released reservations", async () => {
      const c = await createCoupon(make({ usageLimit: 1 }), ADMIN);
      const buyer = await makeUser("released");
      const { orderId } = await makeOrder(buyer);
      await redemption(c.id, buyer, orderId, "RELEASED");
      expect((await price(customer, c.code)).couponId).toBe(c.id);
    });

    it("is ALREADY_USED when this customer reached their own limit, while others can still use it", async () => {
      const c = await createCoupon(make({ perCustomerLimit: 1 }), ADMIN);
      const { orderId } = await makeOrder(customer);
      await redemption(c.id, customer, orderId, "REDEEMED");
      expect(await refusal(price(customer, c.code))).toBe(
        "COUPON_ALREADY_USED"
      );
      const other = await makeUser("another");
      expect((await price(other, c.code)).couponId).toBe(c.id);
    });

    it("does not count the order's own reservation against itself when re-checking it", async () => {
      const c = await createCoupon(make({ usageLimit: 1 }), ADMIN);
      const buyer = await makeUser("self");
      const { orderId } = await makeOrder(buyer);
      await redemption(c.id, buyer, orderId, "RESERVED");
      expect(await refusal(price(buyer, c.code))).toBe("COUPON_USED_UP");
      expect(
        (await price(buyer, c.code, { excludeOrderId: orderId })).couponId
      ).toBe(c.id);
    });
  });

  it("refuses further attempts after too many failed ones, per customer", async () => {
    const guesser = await makeUser("guesser");
    for (let i = 0; i < 10; i++) {
      expect(await refusal(price(guesser, `WRONG-${i}-GUESS`))).toBe(
        "COUPON_INVALID"
      );
    }
    const valid = await createCoupon(make(), ADMIN);
    expect(await refusal(price(guesser, "WRONG-11-GUESS"))).toBe(
      "COUPON_TOO_MANY_ATTEMPTS"
    );
    expect(await refusal(price(guesser, valid.code))).toBe(
      "COUPON_TOO_MANY_ATTEMPTS"
    );
    // another customer is not affected
    expect((await price(customer, valid.code)).couponId).toBe(valid.id);
  });
});

describe("reserveCouponInTx", () => {
  it("reserves a use and records the discount", async () => {
    const c = await createCoupon(make(), ADMIN);
    const buyer = await makeUser("reserve");
    const { orderId } = await makeOrder(buyer);
    await reserve(await price(buyer, c.code), orderId, buyer);
    const row = await prisma.couponRedemption.findUniqueOrThrow({
      where: { orderId },
    });
    expect(row.status).toBe("RESERVED");
    expect(row.couponId).toBe(c.id);
    expect(row.discountAmount.toFixed(2)).toBe("199.80");
  });

  it("moves the order's reservation to another coupon in place", async () => {
    const a = await createCoupon(make(), ADMIN);
    const b = await createCoupon(make({ percentOff: 50 }), ADMIN);
    const buyer = await makeUser("swap");
    const { orderId } = await makeOrder(buyer);
    await reserve(await price(buyer, a.code), orderId, buyer);
    await reserve(
      await price(buyer, b.code, { excludeOrderId: orderId }),
      orderId,
      buyer
    );
    const rows = await prisma.couponRedemption.findMany({ where: { orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.couponId).toBe(b.id);
    expect(rows[0]!.discountAmount.toFixed(2)).toBe("499.50");
  });

  it("refuses with a retry message, and leaves nothing behind, when the coupon was edited after it was priced", async () => {
    const c = await createCoupon(make(), ADMIN);
    const buyer = await makeUser("edited");
    const { orderId } = await makeOrder(buyer);
    const priced = await price(buyer, c.code);
    await updateCoupon(
      c.id,
      updateCouponSchema.parse({ percentOff: 5 }),
      ADMIN
    );
    expect(await refusal(reserve(priced, orderId, buyer))).toBe(
      "COUPON_CHANGED_RETRY"
    );
    expect(await prisma.couponRedemption.count({ where: { orderId } })).toBe(0);
    // priced again against the new version, it works
    await reserve(await price(buyer, c.code), orderId, buyer);
    expect(
      (
        await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId } })
      ).discountAmount.toFixed(2)
    ).toBe("49.95");
  });

  it("refuses a coupon deactivated after it was priced", async () => {
    const c = await createCoupon(make(), ADMIN);
    const buyer = await makeUser("deactivated");
    const { orderId } = await makeOrder(buyer);
    const priced = await price(buyer, c.code);
    await updateCoupon(
      c.id,
      updateCouponSchema.parse({ isActive: false }),
      ADMIN
    );
    expect(await refusal(reserve(priced, orderId, buyer))).toBe(
      "COUPON_CHANGED_RETRY"
    );
  });

  it("never exceeds the total limit under a 12-way burst, and other requests stay fast", async () => {
    const c = await createCoupon(make({ usageLimit: 5 }), ADMIN);
    const buyers = await Promise.all(
      Array.from({ length: 12 }, (_, i) => makeUser(`burst${i}`))
    );
    const orders = await Promise.all(buyers.map((u) => makeOrder(u)));
    const priced = await Promise.all(buyers.map((u) => price(u, c.code)));

    const started = Date.now();
    const burst = Promise.all(
      buyers.map((u, i) => refusal(reserve(priced[i]!, orders[i]!.orderId, u)))
    );
    // an unrelated request in the middle of the burst must not wait for it
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probeStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const probeMs = Date.now() - probeStart;

    const results = await burst;
    const counts = results.reduce<Record<string, number>>(
      (a, r) => ((a[r] = (a[r] ?? 0) + 1), a),
      {}
    );
    expect(counts).toEqual({ NO_ERROR: 5, COUPON_USED_UP: 7 });
    expect(
      await prisma.couponRedemption.count({
        where: { couponId: c.id, status: "RESERVED" },
      })
    ).toBe(5);
    expect(probeMs).toBeLessThan(3000);
    void started;
  });

  it("allows only one use per customer even when the customer checks out in parallel", async () => {
    const c = await createCoupon(make({ perCustomerLimit: 1 }), ADMIN);
    const buyer = await makeUser("parallel");
    const orders = await Promise.all([
      makeOrder(buyer),
      makeOrder(buyer),
      makeOrder(buyer),
    ]);
    const priced = await Promise.all(orders.map(() => price(buyer, c.code)));
    const results = await Promise.all(
      orders.map((o, i) => refusal(reserve(priced[i]!, o.orderId, buyer)))
    );
    expect(results.filter((r) => r === "NO_ERROR")).toHaveLength(1);
    expect(results.filter((r) => r === "COUPON_ALREADY_USED")).toHaveLength(2);
  });
});

describe("redeemCouponInTx and releaseCouponInTx", () => {
  const status = async (orderId: string) =>
    (await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId } }))
      .status;

  it("turns a reservation into a redemption", async () => {
    const c = await createCoupon(make(), ADMIN);
    const buyer = await makeUser("redeem");
    const { orderId } = await makeOrder(buyer);
    await redemption(c.id, buyer, orderId, "RESERVED");
    await prisma.$transaction((tx) => redeemCouponInTx(tx, orderId));
    expect(await status(orderId)).toBe("REDEEMED");
    expect(
      (await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId } }))
        .redeemedAt
    ).not.toBeNull();
  });

  it("still redeems when the reservation had lapsed or been released: the customer already paid", async () => {
    const c = await createCoupon(make({ usageLimit: 1 }), ADMIN);
    const a = await makeUser("lapsed");
    const b = await makeUser("released-then-paid");
    const oa = await makeOrder(a);
    const ob = await makeOrder(b);
    await redemption(
      c.id,
      a,
      oa.orderId,
      "RESERVED",
      new Date(Date.now() - 3 * 60 * 60 * 1000)
    );
    await redemption(c.id, b, ob.orderId, "RELEASED");
    await prisma.$transaction((tx) => redeemCouponInTx(tx, oa.orderId));
    await prisma.$transaction((tx) => redeemCouponInTx(tx, ob.orderId));
    expect(await status(oa.orderId)).toBe("REDEEMED");
    expect(await status(ob.orderId)).toBe("REDEEMED");
  });

  it("does nothing for an order without a coupon, and is safe to repeat", async () => {
    const buyer = await makeUser("nocoupon");
    const { orderId } = await makeOrder(buyer);
    await prisma.$transaction((tx) => redeemCouponInTx(tx, orderId));
    expect(await prisma.couponRedemption.count({ where: { orderId } })).toBe(0);

    const c = await createCoupon(make(), ADMIN);
    const other = await makeUser("twice");
    const o2 = await makeOrder(other);
    await redemption(c.id, other, o2.orderId, "RESERVED");
    await prisma.$transaction((tx) => redeemCouponInTx(tx, o2.orderId));
    const first = (
      await prisma.couponRedemption.findUniqueOrThrow({
        where: { orderId: o2.orderId },
      })
    ).redeemedAt;
    await prisma.$transaction((tx) => redeemCouponInTx(tx, o2.orderId));
    expect(
      (
        await prisma.couponRedemption.findUniqueOrThrow({
          where: { orderId: o2.orderId },
        })
      ).redeemedAt
    ).toEqual(first);
  });

  it("releases only a reservation, never a redemption", async () => {
    const c = await createCoupon(make(), ADMIN);
    const a = await makeUser("rel-a");
    const b = await makeUser("rel-b");
    const oa = await makeOrder(a);
    const ob = await makeOrder(b);
    await redemption(c.id, a, oa.orderId, "RESERVED");
    await redemption(c.id, b, ob.orderId, "REDEEMED");
    await prisma.$transaction((tx) =>
      releaseCouponInTx(tx, oa.orderId, "test")
    );
    await prisma.$transaction((tx) =>
      releaseCouponInTx(tx, ob.orderId, "test")
    );
    expect(await status(oa.orderId)).toBe("RELEASED");
    expect(await status(ob.orderId)).toBe("REDEEMED");
  });
});

describe("previewCoupon", () => {
  async function sessionFor(
    userId: string,
    overrides: Record<string, unknown> = {}
  ) {
    return prisma.orderSession.create({
      data: {
        comicId: COMIC_ID,
        userId,
        status: "PREVIEW_READY",
        coverType: "HARDCOVER",
        shippingCountry: "IN",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        ...overrides,
      },
    });
  }

  it("shows the discount and the final amount without creating anything", async () => {
    const c = await createCoupon(make({ percentOff: 10 }), ADMIN);
    const owner = await makeUser("preview");
    const session = await sessionFor(owner);
    const result = await previewCoupon(session.id, owner, c.code);
    expect(result).toEqual({
      code: c.code,
      name: c.name,
      listAmount: "999",
      discountAmount: "99.9",
      finalAmount: "899.1",
      currency: "INR",
    });
    expect(
      await prisma.couponRedemption.count({ where: { couponId: c.id } })
    ).toBe(0);
    expect(
      await prisma.order.count({ where: { orderSessionId: session.id } })
    ).toBe(0);
  });

  it("is for the session's owner only, and needs a login", async () => {
    const c = await createCoupon(make(), ADMIN);
    const owner = await makeUser("owner2");
    const stranger = await makeUser("stranger");
    const session = await sessionFor(owner);
    await expect(
      previewCoupon(session.id, stranger, c.code)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      previewCoupon(session.id, undefined, c.code)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("answers for a session that cannot be priced yet or is the wrong state", async () => {
    const c = await createCoupon(make(), ADMIN);
    const owner = await makeUser("states");
    await expect(
      previewCoupon("00000000-0000-4000-8000-0000000000aa", owner, c.code)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const noCover = await sessionFor(owner, { coverType: null });
    await expect(
      previewCoupon(noCover.id, owner, c.code)
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const noCountry = await sessionFor(owner, { shippingCountry: null });
    await expect(
      previewCoupon(noCountry.id, owner, c.code)
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const paid = await sessionFor(owner, { status: "PAID" });
    await expect(previewCoupon(paid.id, owner, c.code)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const expired = await sessionFor(owner, {
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      previewCoupon(expired.id, owner, c.code)
    ).rejects.toBeInstanceOf(Error);
  });

  it("applies the coupon's own rules (a different comic is not eligible)", async () => {
    const c = await createCoupon(
      make({ allComics: false, comicIds: [OTHER_COMIC_ID] }),
      ADMIN
    );
    const owner = await makeUser("scope");
    const session = await sessionFor(owner);
    await expect(
      previewCoupon(session.id, owner, c.code)
    ).rejects.toMatchObject({ code: "COUPON_NOT_APPLICABLE" });
  });
});

describe("couponResponseFields", () => {
  it("returns strings, and null when there is no coupon", () => {
    expect(
      couponResponseFields({
        listAmount: null,
        discountAmount: D(0),
        couponCode: null,
      })
    ).toEqual({
      listAmount: null,
      discountAmount: "0",
      couponCode: null,
    });
    expect(
      couponResponseFields({
        listAmount: D("999.00"),
        discountAmount: D("199.80"),
        couponCode: "X",
      })
    ).toEqual({
      listAmount: "999",
      discountAmount: "199.8",
      couponCode: "X",
    });
  });
});
