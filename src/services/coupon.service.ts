import { randomInt } from "crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { CoverType } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import { generateCouponCode } from "../utils/couponCode.js";
import { couponShapeIssues } from "../utils/couponShape.js";
import type { CouponShape } from "../utils/couponShape.js";
import { reservationCutoff } from "../utils/couponPricing.js";
import type {
  CreateCouponInput,
  GenerateCouponsInput,
  ListCouponsQueryInput,
  UpdateCouponInput,
} from "../validators/coupon.schema.js";

// ============================================================
// ADMIN COUPON MANAGEMENT
// ============================================================
//
// Every write that changes an existing coupon takes the coupon's row lock
// (SELECT ... FOR UPDATE) inside a transaction. Checkout takes the same lock
// when it reserves a use, so an admin edit and a checkout can never interleave:
// checkout either sees the old coupon in full or the new one in full, and it
// compares `updatedAt` to notice a change made while it was working.

const COUPON_INCLUDE = {
  comics: { select: { comic: { select: { id: true, title: true } } } },
  restrictedToUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CouponInclude;

type CouponRow = Prisma.CouponGetPayload<{ include: typeof COUPON_INCLUDE }>;

// How many times a generated code is retried when it collides with an existing
// one. The code space is 32^8, so a collision is very rare.
const CODE_ATTEMPTS = 5;

type Usage = { redeemed: number; reserved: number };

/**
 * Redeemed uses and the reservations still inside the window, per coupon, for
 * the admin list. Lapsed reservations are not counted: they no longer hold a
 * use (see RESERVATION_WINDOW_MINUTES).
 */
async function usageFor(couponIds: string[]): Promise<Map<string, Usage>> {
  const usage = new Map<string, Usage>(
    couponIds.map((id) => [id, { redeemed: 0, reserved: 0 }])
  );
  if (couponIds.length === 0) return usage;

  const [redeemed, reserved] = await Promise.all([
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: { couponId: { in: couponIds }, status: "REDEEMED" },
      _count: { _all: true },
    }),
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: {
        couponId: { in: couponIds },
        status: "RESERVED",
        createdAt: { gt: reservationCutoff(new Date()) },
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of redeemed)
    usage.get(row.couponId)!.redeemed = row._count._all;
  for (const row of reserved)
    usage.get(row.couponId)!.reserved = row._count._all;
  return usage;
}

function toCouponResponse(row: CouponRow, usage: Usage) {
  const { comics, ...rest } = row;
  return {
    ...rest,
    comics: comics.map((entry) => entry.comic),
    usage,
  };
}

const toDecimal = (value: number | null | undefined) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value);

/** Locks the coupon row for the rest of the transaction; throws if it is gone. */
async function lockCoupon(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM coupons WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Coupon not found");
}

/** The customer and comics a coupon points at must exist. */
async function assertReferencesExist(
  restrictedToUserId: string | null,
  comicIds: string[]
) {
  if (restrictedToUserId !== null) {
    const user = await prisma.user.findUnique({
      where: { id: restrictedToUserId },
      select: { id: true },
    });
    if (!user) throw new ValidationError("The selected customer was not found");
  }
  if (comicIds.length > 0) {
    const found = await prisma.comic.count({ where: { id: { in: comicIds } } });
    if (found !== new Set(comicIds).size) {
      throw new ValidationError("One or more selected comics were not found");
    }
  }
}

function assertWellFormed(shape: CouponShape) {
  const issues = couponShapeIssues(shape);
  if (issues.length > 0) throw new ValidationError(issues.join(" "));
}

const duplicateCodeError = () =>
  new ConflictError("A coupon with this code already exists");

function randomCode() {
  return generateCouponCode((max) => randomInt(max));
}

// ============================================================
// CREATE
// ============================================================

export async function createCoupon(data: CreateCouponInput, adminId: string) {
  const allComics = data.allComics;
  const comicIds = allComics ? [] : [...new Set(data.comicIds)];
  const usageLimit =
    data.kind === "SINGLE_USE"
      ? (data.usageLimit ?? 1)
      : (data.usageLimit ?? null);

  assertWellFormed({
    kind: data.kind,
    discountType: data.discountType,
    percentOff: data.percentOff ?? null,
    amountOff: data.amountOff ?? null,
    maxDiscount: data.maxDiscount ?? null,
    currency: data.currency ?? null,
    startsAt: data.startsAt ?? null,
    endsAt: data.endsAt ?? null,
    usageLimit,
    perCustomerLimit: data.perCustomerLimit ?? null,
    allComics,
    comicCount: comicIds.length,
  });
  await assertReferencesExist(data.restrictedToUserId ?? null, comicIds);

  // A code the admin typed that is taken is an error; a generated one is retried.
  const attempts = data.code === undefined ? CODE_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const row = await prisma.coupon.create({
        data: {
          code: data.code ?? randomCode(),
          name: data.name,
          description: data.description ?? null,
          kind: data.kind,
          discountType: data.discountType,
          percentOff: toDecimal(data.percentOff),
          amountOff: toDecimal(data.amountOff),
          maxDiscount: toDecimal(data.maxDiscount),
          currency: data.currency ?? null,
          startsAt: data.startsAt ?? null,
          endsAt: data.endsAt ?? null,
          usageLimit,
          perCustomerLimit: data.perCustomerLimit ?? null,
          restrictedToUserId: data.restrictedToUserId ?? null,
          allComics,
          comics: { create: comicIds.map((comicId) => ({ comicId })) },
          countryCodes: data.countryCodes,
          coverTypes: data.coverTypes as CoverType[],
          combinable: data.combinable,
          isActive: data.isActive,
          createdById: adminId,
          updatedById: adminId,
        },
        include: COUPON_INCLUDE,
      });

      logger.info({ couponId: row.id, kind: row.kind }, "Coupon created");
      return toCouponResponse(row, { redeemed: 0, reserved: 0 });
    } catch (error: any) {
      if (error.code === "P2002" && attempt < attempts) continue;
      if (error.code === "P2002") throw duplicateCodeError();
      throw error;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw duplicateCodeError();
}

// ============================================================
// BULK GENERATE SINGLE-USE CODES
// ============================================================

export async function generateCoupons(
  data: GenerateCouponsInput,
  adminId: string
) {
  const { count, ...shared } = data;
  const allComics = shared.allComics;
  const comicIds = allComics ? [] : [...new Set(shared.comicIds)];

  assertWellFormed({
    kind: "SINGLE_USE",
    discountType: shared.discountType,
    percentOff: shared.percentOff ?? null,
    amountOff: shared.amountOff ?? null,
    maxDiscount: shared.maxDiscount ?? null,
    currency: shared.currency ?? null,
    startsAt: shared.startsAt ?? null,
    endsAt: shared.endsAt ?? null,
    usageLimit: 1,
    perCustomerLimit: shared.perCustomerLimit ?? null,
    allComics,
    comicCount: comicIds.length,
  });
  await assertReferencesExist(shared.restrictedToUserId ?? null, comicIds);

  // Codes unique within this batch and not already in use. Each round draws
  // what is still missing and drops any that exist; one round is the norm.
  const codes = new Set<string>();
  while (codes.size < count) {
    const candidates = new Set<string>();
    while (codes.size + candidates.size < count) candidates.add(randomCode());
    const taken = await prisma.coupon.findMany({
      where: { code: { in: [...candidates] } },
      select: { code: true },
    });
    const takenCodes = new Set(taken.map((t) => t.code));
    for (const code of candidates) if (!takenCodes.has(code)) codes.add(code);
  }

  try {
    const rows = await prisma.$transaction(
      [...codes].map((code) =>
        prisma.coupon.create({
          data: {
            code,
            name: shared.name,
            description: shared.description ?? null,
            kind: "SINGLE_USE",
            discountType: shared.discountType,
            percentOff: toDecimal(shared.percentOff),
            amountOff: toDecimal(shared.amountOff),
            maxDiscount: toDecimal(shared.maxDiscount),
            currency: shared.currency ?? null,
            startsAt: shared.startsAt ?? null,
            endsAt: shared.endsAt ?? null,
            usageLimit: 1,
            perCustomerLimit: shared.perCustomerLimit ?? null,
            restrictedToUserId: shared.restrictedToUserId ?? null,
            allComics,
            comics: { create: comicIds.map((comicId) => ({ comicId })) },
            countryCodes: shared.countryCodes,
            coverTypes: shared.coverTypes as CoverType[],
            combinable: shared.combinable,
            isActive: shared.isActive,
            createdById: adminId,
            updatedById: adminId,
          },
          include: COUPON_INCLUDE,
        })
      )
    );

    logger.info({ count: rows.length }, "Single-use coupons generated");
    return rows.map((row) =>
      toCouponResponse(row, { redeemed: 0, reserved: 0 })
    );
  } catch (error: any) {
    // All-or-nothing: a rare collision with a code created a moment ago.
    if (error.code === "P2002") {
      throw new ConflictError(
        "Some generated codes were already taken. Please try again"
      );
    }
    throw error;
  }
}

// ============================================================
// UPDATE
// ============================================================

export async function updateCoupon(
  id: string,
  data: UpdateCouponInput,
  adminId: string
) {
  const row = await prisma
    .$transaction(async (tx) => {
      await lockCoupon(tx, id);

      const existing = await tx.coupon.findUniqueOrThrow({
        where: { id },
        include: COUPON_INCLUDE,
      });

      // undefined = leave as is, null = clear.
      const pick = <T>(incoming: T | undefined, current: T): T =>
        incoming === undefined ? current : incoming;

      const discountType = pick(data.discountType, existing.discountType);
      const kind = pick(data.kind, existing.kind);
      const switchedType = discountType !== existing.discountType;

      // Changing the discount type drops the fields that only belong to the old one.
      let percentOff = pick(
        data.percentOff,
        existing.percentOff?.toNumber() ?? null
      );
      let amountOff = pick(
        data.amountOff,
        existing.amountOff?.toNumber() ?? null
      );
      let maxDiscount = pick(
        data.maxDiscount,
        existing.maxDiscount?.toNumber() ?? null
      );
      if (switchedType && discountType === "FIXED") {
        if (data.percentOff === undefined) percentOff = null;
        if (data.maxDiscount === undefined) maxDiscount = null;
      }
      if (
        switchedType &&
        discountType === "PERCENT" &&
        data.amountOff === undefined
      ) {
        amountOff = null;
      }

      const allComics = pick(data.allComics, existing.allComics);
      const comicIds = allComics
        ? []
        : [...new Set(data.comicIds ?? existing.comics.map((c) => c.comic.id))];

      // Switching to single-use sets the limit to 1 unless one was given.
      let usageLimit = pick(data.usageLimit, existing.usageLimit);
      if (
        kind === "SINGLE_USE" &&
        data.kind === "SINGLE_USE" &&
        data.usageLimit === undefined
      ) {
        usageLimit = 1;
      }

      const merged: CouponShape = {
        kind,
        discountType,
        percentOff,
        amountOff,
        maxDiscount,
        currency: pick(data.currency, existing.currency),
        startsAt: pick(data.startsAt, existing.startsAt),
        endsAt: pick(data.endsAt, existing.endsAt),
        usageLimit,
        perCustomerLimit: pick(
          data.perCustomerLimit,
          existing.perCustomerLimit
        ),
        allComics,
        comicCount: comicIds.length,
      };
      assertWellFormed(merged);

      const restrictedToUserId = pick(
        data.restrictedToUserId,
        existing.restrictedToUserId
      );
      if (
        data.restrictedToUserId !== undefined ||
        data.comicIds !== undefined
      ) {
        await assertReferencesExist(restrictedToUserId, comicIds);
      }

      // A code that customers may already hold or have used is not renamed.
      if (data.code !== undefined && data.code !== existing.code) {
        const used = await tx.couponRedemption.count({
          where: { couponId: id },
        });
        if (used > 0) {
          throw new ConflictError(
            "The code of a coupon that has been used cannot be changed. Create a new coupon instead"
          );
        }
      }

      const updated = await tx.coupon.update({
        where: { id },
        data: {
          ...(data.code !== undefined && { code: data.code }),
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && {
            description: data.description,
          }),
          kind,
          discountType,
          percentOff: toDecimal(percentOff),
          amountOff: toDecimal(amountOff),
          maxDiscount: toDecimal(maxDiscount),
          currency: merged.currency,
          startsAt: merged.startsAt,
          endsAt: merged.endsAt,
          usageLimit,
          perCustomerLimit: merged.perCustomerLimit,
          restrictedToUserId,
          allComics,
          ...(data.countryCodes !== undefined && {
            countryCodes: data.countryCodes,
          }),
          ...(data.coverTypes !== undefined && {
            coverTypes: data.coverTypes as CoverType[],
          }),
          ...(data.combinable !== undefined && { combinable: data.combinable }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          updatedById: adminId,
        },
      });

      // The comic list is replaced whenever it could have changed.
      if (data.allComics !== undefined || data.comicIds !== undefined) {
        await tx.couponComic.deleteMany({ where: { couponId: id } });
        if (comicIds.length > 0) {
          await tx.couponComic.createMany({
            data: comicIds.map((comicId) => ({ couponId: id, comicId })),
          });
        }
      }

      return tx.coupon.findUniqueOrThrow({
        where: { id: updated.id },
        include: COUPON_INCLUDE,
      });
    })
    .catch((error: any) => {
      if (error.code === "P2002") throw duplicateCodeError();
      throw error;
    });

  const usage = (await usageFor([id])).get(id)!;
  logger.info({ couponId: id }, "Coupon updated");
  return toCouponResponse(row, usage);
}

// ============================================================
// STATUS, DELETE, READ
// ============================================================

export async function toggleCouponStatus(id: string, adminId: string) {
  const row = await prisma.$transaction(async (tx) => {
    await lockCoupon(tx, id);
    const existing = await tx.coupon.findUniqueOrThrow({ where: { id } });
    return tx.coupon.update({
      where: { id },
      data: { isActive: !existing.isActive, updatedById: adminId },
      include: COUPON_INCLUDE,
    });
  });

  logger.info(
    { couponId: id, isActive: row.isActive },
    "Coupon status toggled"
  );
  return toCouponResponse(row, (await usageFor([id])).get(id)!);
}

export async function deleteCoupon(id: string) {
  await prisma.$transaction(async (tx) => {
    await lockCoupon(tx, id);
    const used = await tx.couponRedemption.count({ where: { couponId: id } });
    if (used > 0) {
      throw new ConflictError(
        "This coupon has been used and cannot be deleted. Deactivate it instead"
      );
    }
    await tx.coupon.delete({ where: { id } });
  });

  logger.info({ couponId: id }, "Coupon deleted");
}

export async function getCoupon(id: string) {
  const row = await prisma.coupon.findUnique({
    where: { id },
    include: COUPON_INCLUDE,
  });
  if (!row) throw new NotFoundError("Coupon not found");
  return toCouponResponse(row, (await usageFor([id])).get(id)!);
}

export async function listCoupons(filters: ListCouponsQueryInput) {
  const where: Prisma.CouponWhereInput = {};
  if (filters.status) where.isActive = filters.status === "active";
  if (filters.kind) where.kind = filters.kind;
  if (filters.search) {
    where.OR = [
      { code: { contains: filters.search, mode: "insensitive" } },
      { name: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await prisma.$transaction([
    prisma.coupon.findMany({
      where,
      include: COUPON_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.coupon.count({ where }),
  ]);

  const usage = await usageFor(rows.map((row) => row.id));

  return {
    coupons: rows.map((row) => toCouponResponse(row, usage.get(row.id)!)),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}
