// Creating many single-use coupons at once. Runs against the Neon TEST branch
// only (the setup import refuses any other database).
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Lets a test force a generated code to collide: the next `remaining` random
// picks return 0, so a code is "AAAAAAAA" (eight picks make one code); after that
// the picks are real.
const control = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomInt: (max: number) =>
      control.remaining > 0 ? (control.remaining--, 0) : actual.randomInt(max),
  };
});

import { prisma } from "../../src/lib/prisma.js";
import {
  createBulkCoupons,
  listCoupons,
} from "../../src/services/coupon.service.js";
import { createBulkCouponsSchema } from "../../src/validators/coupon.schema.js";
import { ConflictError, ValidationError } from "../../src/utils/errors.js";

const MARK = "__vitest_bulk__";
const RUN = Math.random().toString(36).slice(2, 8);
const ADMIN = `${MARK}-admin`;

let comicIds: string[] = [];

const make = (overrides: Record<string, unknown> = {}) =>
  createBulkCouponsSchema.parse({
    name: `${MARK} ${RUN} batch`,
    discountType: "PERCENT",
    percentOff: 15,
    quantity: 3,
    ...overrides,
  });

const countMine = () =>
  prisma.coupon.count({ where: { name: { startsWith: MARK } } });

async function cleanup() {
  await prisma.coupon.deleteMany({
    where: { OR: [{ name: { startsWith: MARK } }, { code: "AAAAAAAA" }] },
  });
}

beforeAll(async () => {
  await cleanup();
  comicIds = (
    await prisma.comic.findMany({ take: 2, select: { id: true } })
  ).map((c) => c.id);
  if (comicIds.length < 2) {
    throw new Error(
      "The test database needs at least two comics (run the seed script)."
    );
  }
});

afterAll(async () => {
  control.remaining = 0;
  await cleanup();
  await prisma.$disconnect();
});

describe("createBulkCoupons", () => {
  it("creates the requested number of single-use coupons with distinct generated codes", async () => {
    const coupons = await createBulkCoupons(make({ quantity: 5 }), ADMIN);

    expect(coupons).toHaveLength(5);
    expect(new Set(coupons.map((c) => c.code)).size).toBe(5);
    for (const c of coupons) {
      expect(c.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(c).toMatchObject({
        kind: "SINGLE_USE",
        usageLimit: 1,
        discountType: "PERCENT",
        showAtCheckout: false,
        restrictedToUserId: null,
        isActive: true,
        createdById: ADMIN,
        updatedById: ADMIN,
        usage: { redeemed: 0, reserved: 0 },
      });
      expect(c.percentOff?.toString()).toBe("15");
    }
    // Sorted by code, so the admin sees a stable list.
    const codes = coupons.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
  });

  it("lists a batch page by page without repeating or skipping a coupon", async () => {
    // One batch shares a createdAt, so the order inside it must still be stable.
    const tag = `page-${RUN}`;
    const coupons = await createBulkCoupons(
      make({ name: `${MARK} ${tag} batch`, quantity: 7 }),
      ADMIN
    );

    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await listCoupons({ page, pageSize: 2, search: tag });
      seen.push(...result.coupons.map((c) => c.id));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(coupons.map((c) => c.id)));
  });

  it("makes a hundred in one go, all stored", async () => {
    const before = await countMine();
    const started = Date.now();
    const coupons = await createBulkCoupons(
      make({ quantity: 100, name: `${MARK} ${RUN} hundred` }),
      ADMIN
    );
    const seconds = (Date.now() - started) / 1000;

    expect(coupons).toHaveLength(100);
    expect(new Set(coupons.map((c) => c.code)).size).toBe(100);
    expect(await countMine()).toBe(before + 100);
    // Three statements however many codes: one create per code would take far longer.
    expect(seconds).toBeLessThan(20);
  });

  it("uses the chosen code length, and the same rules for every coupon", async () => {
    const coupons = await createBulkCoupons(
      make({
        quantity: 3,
        codeLength: 12,
        discountType: "FIXED",
        percentOff: undefined,
        amountOff: 50,
        currency: "INR",
        allComics: false,
        comicIds,
        coverTypes: ["HARDCOVER"],
        firstOrderOnly: true,
        description: "Gift codes",
      }),
      ADMIN
    );

    for (const c of coupons) {
      expect(c.code).toHaveLength(12);
      expect(c).toMatchObject({
        discountType: "FIXED",
        currency: "INR",
        allComics: false,
        coverTypes: ["HARDCOVER"],
        firstOrderOnly: true,
        perCustomerLimit: 1,
        description: "Gift codes",
      });
      expect(c.amountOff?.toString()).toBe("50");
      expect(c.comics.map((x) => x.id).sort()).toEqual([...comicIds].sort());
    }
  });

  it("ignores what makes no sense for a batch: kind, a total limit, one customer, checkout display, a typed code", async () => {
    const [coupon] = await createBulkCoupons(
      make({
        quantity: 1,
        kind: "PUBLIC",
        usageLimit: 500,
        restrictedToUserId: "someone",
        showAtCheckout: true,
        code: "TYPED-CODE",
      }),
      ADMIN
    );
    expect(coupon).toMatchObject({
      kind: "SINGLE_USE",
      usageLimit: 1,
      restrictedToUserId: null,
      showAtCheckout: false,
    });
    expect(coupon!.code).not.toBe("TYPED-CODE");
  });

  it("creates none when the rules are wrong", async () => {
    const before = await countMine();
    const bad: Record<string, unknown>[] = [
      { percentOff: undefined }, // a percentage coupon needs a percentage
      { perCustomerLimit: 2 }, // a single-use coupon is used once
      { endsAt: "2020-01-01" }, // already ended
      { allComics: false, comicIds: [] }, // no comics chosen
      { discountType: "FIXED", percentOff: undefined, amountOff: 10 }, // fixed needs a currency
    ];
    for (const overrides of bad) {
      await expect(
        createBulkCoupons(make(overrides), ADMIN)
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await countMine()).toBe(before);
  });

  it("creates none when a chosen comic does not exist", async () => {
    const before = await countMine();
    await expect(
      createBulkCoupons(
        make({
          allComics: false,
          comicIds: ["00000000-0000-4000-8000-000000000000"],
        }),
        ADMIN
      )
    ).rejects.toThrow(/comics were not found/);
    expect(await countMine()).toBe(before);
  });

  it("tries a fresh set of codes when one is already taken", async () => {
    const taken = await prisma.coupon.create({
      data: {
        code: "AAAAAAAA",
        name: `${MARK} ${RUN} taken`,
        kind: "PUBLIC",
        discountType: "PERCENT",
        percentOff: 5,
        createdById: ADMIN,
        updatedById: ADMIN,
      },
    });
    try {
      // The first code is forced to "AAAAAAAA", which collides; the retry is real.
      control.remaining = 8;
      const [coupon] = await createBulkCoupons(make({ quantity: 1 }), ADMIN);
      expect(coupon!.code).not.toBe("AAAAAAAA");
      expect(await prisma.coupon.count({ where: { code: "AAAAAAAA" } })).toBe(
        1
      );
      expect(
        await prisma.coupon.findUnique({ where: { id: taken.id } })
      ).not.toBeNull();
    } finally {
      control.remaining = 0;
      await prisma.coupon.delete({ where: { id: taken.id } });
    }
  });

  it("gives up with a clear error, creating nothing, when every attempt collides", async () => {
    const taken = await prisma.coupon.create({
      data: {
        code: "AAAAAAAA",
        name: `${MARK} ${RUN} taken2`,
        kind: "PUBLIC",
        discountType: "PERCENT",
        percentOff: 5,
        createdById: ADMIN,
        updatedById: ADMIN,
      },
    });
    const before = await countMine();
    try {
      // Five attempts, eight picks each: every one produces "AAAAAAAA".
      control.remaining = 40;
      await expect(
        createBulkCoupons(make({ quantity: 1 }), ADMIN)
      ).rejects.toBeInstanceOf(ConflictError);
      // Only the pre-made "taken2" coupon is new compared with `before`.
      expect(await countMine()).toBe(before);
    } finally {
      control.remaining = 0;
      await prisma.coupon.delete({ where: { id: taken.id } });
    }
  });
});
