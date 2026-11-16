// Integration tests for the admin coupon service. They run against the Neon
// TEST branch only: the setup import below refuses any other database.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  createCouponSchema,
  updateCouponSchema,
} from "../../src/validators/coupon.schema.js";
import {
  createCoupon,
  deleteCoupon,
  searchCouponCustomers,
  getCoupon,
  listCoupons,
  toggleCouponStatus,
  updateCoupon,
} from "../../src/services/coupon.service.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/utils/errors.js";
import { isValidCouponCode } from "../../src/utils/couponCode.js";

// Everything these tests create carries this marker, so cleanup is exact.
const MARK = "__vitest_coupon__";
const ADMIN = "vitest-admin";
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
let n = 0;
const code = () => `TST-${RUN}-${++n}`;

const make = (overrides: Record<string, unknown> = {}) =>
  createCouponSchema.parse({
    name: `${MARK} offer`,
    discountType: "PERCENT",
    percentOff: 20,
    code: code(),
    ...overrides,
  });

let userId: string;
let comicIds: string[] = [];

/**
 * Removes everything these tests ever created, including leftovers from an
 * earlier failed run: the marked coupons, the test user, and the orders and
 * sessions that belong to that user (deleted in foreign-key order).
 */
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
  const userIds = users.map((u) => u.id);
  const sessions = await prisma.orderSession.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  await prisma.couponRedemption.deleteMany({
    where: {
      OR: [{ couponId: { in: couponIds } }, { userId: { in: userIds } }],
    },
  });
  await prisma.order.deleteMany({
    where: { orderSessionId: { in: sessionIds } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** A minimal order, so a redemption can point at one without depending on leftover data. */
async function makeOrder() {
  const session = await prisma.orderSession.create({
    data: {
      comicId: comicIds[0]!,
      userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: 100,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
    },
  });
  return order.id;
}

beforeAll(async () => {
  await cleanup();
  const user = await prisma.user.create({
    data: {
      id: `${MARK}-${RUN}`,
      name: "Vitest Customer",
      email: `${MARK}-${RUN}@example.test`,
    },
  });
  userId = user.id;
  comicIds = (
    await prisma.comic.findMany({ take: 2, select: { id: true } })
  ).map((c) => c.id);
  // The tests need two comics; fail loudly rather than skip if the data is missing.
  if (comicIds.length < 2) {
    throw new Error(
      "The test database needs at least two comics (run the seed script)."
    );
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** A redemption row for a coupon, for the usage and delete rules. */
const redeem = async (
  couponId: string,
  status: "RESERVED" | "REDEEMED" | "RELEASED",
  createdAt?: Date
) =>
  prisma.couponRedemption.create({
    data: {
      couponId,
      orderId: await makeOrder(),
      userId,
      status,
      discountAmount: 10,
      ...(createdAt && { createdAt }),
    },
  });

describe("createCoupon", () => {
  it("creates a coupon and stores money as decimals", async () => {
    const c = await createCoupon(
      make({ percentOff: 12.5, maxDiscount: 300, currency: "INR" }),
      ADMIN
    );
    expect(c.percentOff?.toString()).toBe("12.5");
    expect(c.maxDiscount?.toString()).toBe("300");
    expect(c.currency).toBe("INR");
    expect(c.usage).toEqual({ redeemed: 0, reserved: 0 });
    expect(c.createdById).toBe(ADMIN);
    expect(c.updatedById).toBe(ADMIN);
  });

  it("generates a valid unique code when none is given", async () => {
    const input = createCouponSchema.parse({
      name: `${MARK} auto`,
      discountType: "PERCENT",
      percentOff: 10,
    });
    const a = await createCoupon(input, ADMIN);
    const b = await createCoupon(input, ADMIN);
    expect(isValidCouponCode(a.code)).toBe(true);
    expect(a.code).not.toBe(b.code);
  });

  it("refuses a duplicate code", async () => {
    const input = make();
    await createCoupon(input, ADMIN);
    await expect(createCoupon(input, ADMIN)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("makes a single-use coupon with a total limit of 1", async () => {
    const c = await createCoupon(make({ kind: "SINGLE_USE" }), ADMIN);
    expect(c.kind).toBe("SINGLE_USE");
    expect(c.usageLimit).toBe(1);
  });

  it("refuses a single-use coupon with another limit", async () => {
    await expect(
      createCoupon(make({ kind: "SINGLE_USE", usageLimit: 5 }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses rules that do not fit together", async () => {
    const bad: Record<string, unknown>[] = [
      { percentOff: 150 },
      { discountType: "FIXED", percentOff: undefined, amountOff: 100 },
      {
        discountType: "FIXED",
        percentOff: 10,
        amountOff: 100,
        currency: "INR",
      },
      { maxDiscount: 100 },
      { startsAt: "2026-12-31", endsAt: "2026-12-01" },
      { allComics: false },
    ];
    for (const overrides of bad) {
      await expect(
        createCoupon(make(overrides), ADMIN),
        JSON.stringify(overrides)
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("refuses a customer or comics that do not exist", async () => {
    await expect(
      createCoupon(make({ restrictedToUserId: "nobody" }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCoupon(
        make({
          allComics: false,
          comicIds: ["22222222-2222-4222-8222-222222222222"],
        }),
        ADMIN
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("restricts a coupon to a customer and to chosen comics", async () => {
    const c = await createCoupon(
      make({
        restrictedToUserId: userId,
        allComics: false,
        comicIds: comicIds,
        countryCodes: ["in"],
        coverTypes: ["HARDCOVER"],
      }),
      ADMIN
    );
    expect(c.restrictedToUser?.id).toBe(userId);
    expect(c.comics.map((x) => x.id).sort()).toEqual([...comicIds].sort());
    expect(c.countryCodes).toEqual(["IN"]);
    expect(c.coverTypes).toEqual(["HARDCOVER"]);
  });

  it("ignores a comic list when the coupon is for all comics", async () => {
    const c = await createCoupon(make({ allComics: true, comicIds }), ADMIN);
    expect(c.comics).toEqual([]);
  });

  it("is refused by the database itself if a rule is bypassed (CHECK constraints)", async () => {
    const attempt = (data: Record<string, unknown>) =>
      prisma.coupon.create({
        data: {
          code: code(),
          name: `${MARK} raw`,
          discountType: "PERCENT",
          percentOff: 10,
          createdById: ADMIN,
          updatedById: ADMIN,
          ...data,
        } as never,
      });
    await expect(attempt({ percentOff: 150 })).rejects.toThrow();
    await expect(attempt({ percentOff: 0 })).rejects.toThrow();
    await expect(attempt({ code: "bad code" })).rejects.toThrow();
    await expect(
      attempt({ discountType: "FIXED", percentOff: null, amountOff: 50 })
    ).rejects.toThrow(); // no currency
    await expect(attempt({ usageLimit: 0 })).rejects.toThrow();
    await expect(
      attempt({
        startsAt: new Date("2026-12-31"),
        endsAt: new Date("2026-12-01"),
      })
    ).rejects.toThrow();
  });
});

describe("updateCoupon", () => {
  it("changes fields, records who changed it, and bumps updatedAt", async () => {
    const c = await createCoupon(make(), ADMIN);
    const u = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ name: `${MARK} renamed`, percentOff: 30 }),
      "other-admin"
    );
    expect(u.name).toBe(`${MARK} renamed`);
    expect(u.percentOff?.toString()).toBe("30");
    expect(u.updatedById).toBe("other-admin");
    expect(u.createdById).toBe(ADMIN);
    expect(u.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime());
  });

  it("leaves fields that were not sent alone", async () => {
    const c = await createCoupon(
      make({ usageLimit: 50, perCustomerLimit: 2, countryCodes: ["IN"] }),
      ADMIN
    );
    const u = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ description: "hello" }),
      ADMIN
    );
    expect(u.usageLimit).toBe(50);
    expect(u.perCustomerLimit).toBe(2);
    expect(u.countryCodes).toEqual(["IN"]);
    expect(u.percentOff?.toString()).toBe("20");
  });

  it("clears optional fields with null", async () => {
    const c = await createCoupon(
      make({ usageLimit: 50, endsAt: "2026-12-31", description: "x" }),
      ADMIN
    );
    const u = await updateCoupon(
      c.id,
      updateCouponSchema.parse({
        usageLimit: null,
        endsAt: null,
        description: null,
      }),
      ADMIN
    );
    expect(u.usageLimit).toBeNull();
    expect(u.endsAt).toBeNull();
    expect(u.description).toBeNull();
  });

  it("drops the fields of the old type when the discount type changes", async () => {
    const c = await createCoupon(
      make({ percentOff: 10, maxDiscount: 100, currency: "INR" }),
      ADMIN
    );
    const u = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ discountType: "FIXED", amountOff: 75 }),
      ADMIN
    );
    expect(u.discountType).toBe("FIXED");
    expect(u.amountOff?.toString()).toBe("75");
    expect(u.percentOff).toBeNull();
    expect(u.maxDiscount).toBeNull();
    const back = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ discountType: "PERCENT", percentOff: 15 }),
      ADMIN
    );
    expect(back.amountOff).toBeNull();
    expect(back.percentOff?.toString()).toBe("15");
  });

  it("refuses an update that would make the stored coupon invalid", async () => {
    const c = await createCoupon(make(), ADMIN);
    await expect(
      updateCoupon(c.id, updateCouponSchema.parse({ maxDiscount: 100 }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError); // no currency
    await expect(
      updateCoupon(c.id, updateCouponSchema.parse({ allComics: false }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
    const after = await getCoupon(c.id);
    expect(after.maxDiscount).toBeNull();
    expect(after.allComics).toBe(true);
  });

  it("replaces the comic list", async () => {
    const c = await createCoupon(
      make({ allComics: false, comicIds: [comicIds[0]!] }),
      ADMIN
    );
    const u = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ comicIds: [comicIds[1]!] }),
      ADMIN
    );
    expect(u.comics.map((x) => x.id)).toEqual([comicIds[1]]);
    const all = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ allComics: true }),
      ADMIN
    );
    expect(all.comics).toEqual([]);
  });

  it("refuses a code that another coupon already uses", async () => {
    const a = await createCoupon(make(), ADMIN);
    const b = await createCoupon(make(), ADMIN);
    await expect(
      updateCoupon(b.id, updateCouponSchema.parse({ code: a.code }), ADMIN)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows a code change before use and blocks it after", async () => {
    const c = await createCoupon(make(), ADMIN);
    const renamed = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ code: code() }),
      ADMIN
    );
    expect(renamed.code).not.toBe(c.code);

    await redeem(c.id, "REDEEMED");
    await expect(
      updateCoupon(c.id, updateCouponSchema.parse({ code: code() }), ADMIN)
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not let the total limit drop below the uses already counted", async () => {
    const c = await createCoupon(make({ usageLimit: 10 }), ADMIN);
    await redeem(c.id, "REDEEMED");
    await redeem(c.id, "RESERVED");
    await expect(
      updateCoupon(c.id, updateCouponSchema.parse({ usageLimit: 1 }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
    // exactly the counted uses is fine, and so is removing the limit
    const ok = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ usageLimit: 2 }),
      ADMIN
    );
    expect(ok.usageLimit).toBe(2);
    const open = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ usageLimit: null }),
      ADMIN
    );
    expect(open.usageLimit).toBeNull();
  });

  it("answers NotFound for an unknown coupon", async () => {
    await expect(
      updateCoupon("missing", updateCouponSchema.parse({ name: "x" }), ADMIN)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serialises two simultaneous edits instead of corrupting the coupon", async () => {
    const c = await createCoupon(make(), ADMIN);
    const [a, b] = await Promise.all([
      updateCoupon(
        c.id,
        updateCouponSchema.parse({ percentOff: 11 }),
        "admin-a"
      ),
      updateCoupon(
        c.id,
        updateCouponSchema.parse({ usageLimit: 7 }),
        "admin-b"
      ),
    ]);
    const final = await getCoupon(c.id);
    expect(final.percentOff?.toString()).toBe("11");
    expect(final.usageLimit).toBe(7);
    expect(Math.max(a.updatedAt.getTime(), b.updatedAt.getTime())).toBe(
      final.updatedAt.getTime()
    );
  });
});

describe("toggleCouponStatus", () => {
  it("flips isActive each time and bumps updatedAt", async () => {
    const c = await createCoupon(make(), ADMIN);
    const off = await toggleCouponStatus(c.id, ADMIN);
    expect(off.isActive).toBe(false);
    expect(off.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime());
    const on = await toggleCouponStatus(c.id, ADMIN);
    expect(on.isActive).toBe(true);
  });

  it("answers NotFound for an unknown coupon", async () => {
    await expect(toggleCouponStatus("missing", ADMIN)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe("deleteCoupon", () => {
  it("deletes an unused coupon", async () => {
    const c = await createCoupon(make({ allComics: false, comicIds }), ADMIN);
    await deleteCoupon(c.id);
    await expect(getCoupon(c.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.couponComic.count({ where: { couponId: c.id } })).toBe(
      0
    );
  });

  it("refuses to delete a coupon that has been used, and keeps it", async () => {
    const c = await createCoupon(make(), ADMIN);
    await redeem(c.id, "RELEASED");
    await expect(deleteCoupon(c.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await getCoupon(c.id)).id).toBe(c.id);
  });

  it("answers NotFound for an unknown coupon", async () => {
    await expect(deleteCoupon("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("usage counts", () => {
  it("counts redeemed uses and live reservations, but not lapsed or released ones", async () => {
    const c = await createCoupon(make(), ADMIN);
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await redeem(c.id, "REDEEMED");
    await redeem(c.id, "RESERVED");
    await redeem(c.id, "RESERVED", longAgo);
    await redeem(c.id, "RELEASED");
    const got = await getCoupon(c.id);
    expect(got.usage).toEqual({ redeemed: 1, reserved: 1 });
  });
});

describe("listCoupons", () => {
  it("filters by status, kind and search, and reports pagination", async () => {
    const tag = `list-${RUN}`;
    const a = await createCoupon(make({ name: `${MARK} ${tag} alpha` }), ADMIN);
    const b = await createCoupon(
      make({ name: `${MARK} ${tag} beta`, kind: "SINGLE_USE" }),
      ADMIN
    );
    await toggleCouponStatus(b.id, ADMIN);

    const base = { page: 1, pageSize: 20 };
    const all = await listCoupons({ ...base, search: tag });
    expect(all.coupons.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    });

    expect(
      (
        await listCoupons({ ...base, search: tag, status: "active" })
      ).coupons.map((x) => x.id)
    ).toEqual([a.id]);
    expect(
      (
        await listCoupons({ ...base, search: tag, status: "inactive" })
      ).coupons.map((x) => x.id)
    ).toEqual([b.id]);
    expect(
      (
        await listCoupons({ ...base, search: tag, kind: "SINGLE_USE" })
      ).coupons.map((x) => x.id)
    ).toEqual([b.id]);
    expect(
      (
        await listCoupons({ ...base, search: a.code.toLowerCase() })
      ).coupons.map((x) => x.id)
    ).toEqual([a.id]);
    expect(
      (await listCoupons({ ...base, search: "no-such-thing-xyz" })).coupons
    ).toEqual([]);

    const paged = await listCoupons({ page: 2, pageSize: 1, search: tag });
    expect(paged.coupons).toHaveLength(1);
    expect(paged.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
  });

  it("lists the newest first", async () => {
    const tag = `order-${RUN}`;
    const first = await createCoupon(make({ name: `${MARK} ${tag} 1` }), ADMIN);
    const second = await createCoupon(
      make({ name: `${MARK} ${tag} 2` }),
      ADMIN
    );
    const ids = (
      await listCoupons({ page: 1, pageSize: 20, search: tag })
    ).coupons.map((x) => x.id);
    expect(ids).toEqual([second.id, first.id]);
  });
});

describe("a currency must fit the countries", () => {
  // Throwaway countries, so these tests do not depend on what the database holds.
  beforeAll(async () => {
    for (const [code, currencyCode] of [
      ["ZY", "ZYC"],
      ["ZX", "ZXC"],
    ] as const) {
      await prisma.country.upsert({
        where: { code },
        update: { currencyCode, isActive: true },
        create: { code, name: `${MARK} ${code}`, currencyCode, flagUrl: "x" },
      });
    }
  });
  afterAll(async () => {
    await prisma.country.deleteMany({ where: { code: { in: ["ZY", "ZX"] } } });
  });

  const fixed = (overrides: Record<string, unknown>) =>
    make({
      discountType: "FIXED",
      percentOff: undefined,
      amountOff: 10,
      currency: "ZYC",
      ...overrides,
    });

  it("accepts a currency that a selected country uses, or that any country uses when none is selected", async () => {
    await createCoupon(fixed({ countryCodes: ["ZY"] }), ADMIN);
    await createCoupon(fixed({ countryCodes: ["ZY", "ZX"] }), ADMIN);
    await createCoupon(fixed({ countryCodes: [] }), ADMIN);
  });

  it("refuses a currency that none of the selected countries uses", async () => {
    await expect(
      createCoupon(fixed({ countryCodes: ["ZX"] }), ADMIN)
    ).rejects.toThrow(/None of the selected countries sells in ZYC/);
  });

  it("refuses a currency that no country uses, such as a made-up one", async () => {
    await expect(
      createCoupon(fixed({ currency: "QQQ" }), ADMIN)
    ).rejects.toThrow(/No country sells in QQQ/);
  });

  it("does not count a country that is switched off", async () => {
    await prisma.country.update({
      where: { code: "ZX" },
      data: { isActive: false },
    });
    await expect(
      createCoupon(fixed({ currency: "ZXC", countryCodes: ["ZX"] }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
    await prisma.country.update({
      where: { code: "ZX" },
      data: { isActive: true },
    });
  });

  it("checks again on edit when the currency or the countries change, but not for other edits", async () => {
    const c = await createCoupon(fixed({ countryCodes: ["ZY"] }), ADMIN);
    await expect(
      updateCoupon(
        c.id,
        updateCouponSchema.parse({ countryCodes: ["ZX"] }),
        ADMIN
      )
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateCoupon(c.id, updateCouponSchema.parse({ currency: "QQQ" }), ADMIN)
    ).rejects.toBeInstanceOf(ValidationError);
    // an unrelated edit still works, and the coupon is unchanged by the refusals
    const renamed = await updateCoupon(
      c.id,
      updateCouponSchema.parse({ name: `${MARK} renamed` }),
      ADMIN
    );
    expect(renamed.countryCodes).toEqual(["ZY"]);
    expect(renamed.currency).toBe("ZYC");
  });

  it("leaves a percentage coupon without a currency alone", async () => {
    await createCoupon(
      createCouponSchema.parse(make({ countryCodes: ["ZX"] })),
      ADMIN
    );
  });
});

describe("code length", () => {
  it("makes a generated code of the length the admin chose", async () => {
    for (const codeLength of [4, 8, 12, 32]) {
      const c = await createCoupon(
        createCouponSchema.parse({ ...make(), code: undefined, codeLength }),
        ADMIN
      );
      expect(c.code).toHaveLength(codeLength);
      expect(isValidCouponCode(c.code)).toBe(true);
    }
  });

  it("uses the default length when none is given, and ignores the length for a typed code", async () => {
    const generated = await createCoupon(
      createCouponSchema.parse({ ...make(), code: undefined }),
      ADMIN
    );
    expect(generated.code).toHaveLength(8);
    const typed = await createCoupon(
      createCouponSchema.parse({ ...make(), code: code(), codeLength: 12 }),
      ADMIN
    );
    expect(typed.code).toHaveLength(code().length);
  });
});

describe("searchCouponCustomers", () => {
  it("finds registered users who have never ordered, by name or email, in any case", async () => {
    // the test user has no order at all
    const byEmail = await searchCouponCustomers(
      userId.toUpperCase().slice(0, 20)
    );
    expect(byEmail.map((u) => u.id)).toContain(userId);
    const byName = await searchCouponCustomers("vitest customer");
    expect(byName.map((u) => u.id)).toContain(userId);
    expect(byName[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        email: expect.any(String),
      })
    );
  });

  it("returns at most 10 and nothing for text that matches nobody", async () => {
    expect((await searchCouponCustomers("vi")).length).toBeLessThanOrEqual(10);
    expect(await searchCouponCustomers("zzzz-nobody-has-this-xyz")).toEqual([]);
  });
});
