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
import { COUPON_TRANSACTION_OPTIONS } from "../config/coupon.js";
import { generateCouponCode } from "../utils/couponCode.js";
import { couponShapeIssues, pastDateIssues } from "../utils/couponShape.js";
import type { CouponShape } from "../utils/couponShape.js";
import { reservationCutoff } from "../utils/couponPricing.js";
import type {
  CreateCouponInput,
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
// one. The longer the code, the rarer a collision; the retries are a safety net.
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

/**
 * Makes a search text match literally: Prisma's `contains` passes % and _ to
 * the database as wildcards, so they (and the escape character) are escaped.
 */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const toDecimal = (value: number | null | undefined) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value);

/** Locks the coupon row for the rest of the transaction; throws if it is gone. */
async function lockCoupon(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM coupons WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Coupon not found");
}

/**
 * A coupon in a currency must be able to apply somewhere: some country, among
 * the selected ones (or any, when none are selected), has to sell in that
 * currency. Otherwise every customer would be told it does not apply.
 */
async function assertCurrencyFitsCountries(
  db: { country: typeof prisma.country },
  currency: string | null,
  countryCodes: string[]
) {
  if (currency === null) return;
  const rows = await db.country.findMany({
    where: { currencyCode: currency, isActive: true },
    select: { code: true },
  });
  const usingIt = new Set(rows.map((row) => row.code));
  const fits =
    countryCodes.length === 0
      ? usingIt.size > 0
      : countryCodes.some((code) => usingIt.has(code));
  if (fits) return;
  throw new ValidationError(
    countryCodes.length === 0
      ? `No country sells in ${currency}, so this coupon could never apply. Choose a currency that one of your countries uses.`
      : `None of the selected countries sells in ${currency}, so this coupon could never apply. Choose a country that uses it, or change the currency.`
  );
}

/** Every selected country must be a country in the database (active or not). */
async function assertCountriesExist(
  db: { country: typeof prisma.country },
  countryCodes: string[]
) {
  if (countryCodes.length === 0) return;
  const rows = await db.country.findMany({
    where: { code: { in: countryCodes } },
    select: { code: true },
  });
  const known = new Set(rows.map((row) => row.code));
  const unknown = countryCodes.filter((code) => !known.has(code));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown country code: ${unknown.slice(0, 5).join(", ")}`
    );
  }
}

/** The customer and comics a coupon points at must exist. */
async function assertReferencesExist(
  db: Prisma.TransactionClient | typeof prisma,
  restrictedToUserId: string | null,
  comicIds: string[]
) {
  if (restrictedToUserId !== null) {
    const user = await db.user.findUnique({
      where: { id: restrictedToUserId },
      select: { id: true },
    });
    if (!user) throw new ValidationError("The selected customer was not found");
  }
  if (comicIds.length > 0) {
    const found = await db.comic.count({ where: { id: { in: comicIds } } });
    if (found !== new Set(comicIds).size) {
      throw new ValidationError("One or more selected comics were not found");
    }
  }
}

function assertWellFormed(
  shape: CouponShape,
  previous?: { startsAt: Date | null; endsAt: Date | null }
) {
  const issues = [
    ...couponShapeIssues(shape),
    ...pastDateIssues(shape, new Date(), previous),
  ];
  if (issues.length > 0) throw new ValidationError(issues.join(" "));
}

const duplicateCodeError = () =>
  new ConflictError("A coupon with this code already exists");

function randomCode(length?: number) {
  return generateCouponCode((max) => randomInt(max), length);
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

  // A first-order coupon is used once per customer; an empty limit becomes 1.
  const perCustomerLimit =
    data.firstOrderOnly && data.perCustomerLimit === undefined
      ? 1
      : (data.perCustomerLimit ?? null);

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
    perCustomerLimit,
    allComics,
    comicCount: comicIds.length,
    restrictedToUserId: data.restrictedToUserId ?? null,
    showAtCheckout: data.showAtCheckout,
    firstOrderOnly: data.firstOrderOnly,
  });
  await assertReferencesExist(
    prisma,
    data.restrictedToUserId ?? null,
    comicIds
  );
  await assertCountriesExist(prisma, data.countryCodes);
  await assertCurrencyFitsCountries(
    prisma,
    data.currency ?? null,
    data.countryCodes
  );

  // A code the admin typed that is taken is an error; a generated one is retried.
  const attempts = data.code === undefined ? CODE_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const row = await prisma.coupon.create({
        data: {
          code: data.code ?? randomCode(data.codeLength),
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
          perCustomerLimit,
          restrictedToUserId: data.restrictedToUserId ?? null,
          allComics,
          comics: { create: comicIds.map((comicId) => ({ comicId })) },
          countryCodes: data.countryCodes,
          coverTypes: data.coverTypes as CoverType[],
          combinable: data.combinable,
          showAtCheckout: data.showAtCheckout,
          firstOrderOnly: data.firstOrderOnly,
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
      if (data.kind === "SINGLE_USE" && data.usageLimit === undefined) {
        usageLimit = 1;
      }

      const restrictedToUserId = pick(
        data.restrictedToUserId,
        existing.restrictedToUserId
      );
      const showAtCheckout = pick(data.showAtCheckout, existing.showAtCheckout);
      const firstOrderOnly = pick(data.firstOrderOnly, existing.firstOrderOnly);

      // A first-order coupon is used once per customer; an empty limit becomes 1.
      let perCustomerLimit = pick(
        data.perCustomerLimit,
        existing.perCustomerLimit
      );
      if (firstOrderOnly && perCustomerLimit === null) perCustomerLimit = 1;

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
        perCustomerLimit,
        allComics,
        comicCount: comicIds.length,
        restrictedToUserId,
        showAtCheckout,
        firstOrderOnly,
      };
      assertWellFormed(merged, existing);

      if (
        data.restrictedToUserId !== undefined ||
        data.comicIds !== undefined
      ) {
        await assertReferencesExist(tx, restrictedToUserId, comicIds);
      }

      if (data.countryCodes !== undefined) {
        await assertCountriesExist(tx, data.countryCodes);
      }
      if (data.currency !== undefined || data.countryCodes !== undefined) {
        await assertCurrencyFitsCountries(
          tx,
          merged.currency,
          pick(data.countryCodes, existing.countryCodes)
        );
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

      // The total limit cannot be set below the uses already counted: redeemed ones
      // and reservations still inside the window.
      if (data.usageLimit !== undefined && merged.usageLimit !== null) {
        const counted = await tx.couponRedemption.count({
          where: {
            couponId: id,
            OR: [
              { status: "REDEEMED" },
              {
                status: "RESERVED",
                createdAt: { gt: reservationCutoff(new Date()) },
              },
            ],
          },
        });
        if (merged.usageLimit < counted) {
          throw new ValidationError(
            `This coupon has already been used or reserved ${counted} times, so the total limit cannot be lower than ${counted}.`
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
          perCustomerLimit,
          restrictedToUserId,
          allComics,
          ...(data.countryCodes !== undefined && {
            countryCodes: data.countryCodes,
          }),
          ...(data.coverTypes !== undefined && {
            coverTypes: data.coverTypes as CoverType[],
          }),
          ...(data.combinable !== undefined && { combinable: data.combinable }),
          showAtCheckout,
          firstOrderOnly,
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
    }, COUPON_TRANSACTION_OPTIONS)
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

/**
 * Flips the coupon on or off. With `isActive` it is set to exactly that instead,
 * so two quick clicks, or a page that is out of date, cannot end in the wrong
 * state.
 */
export async function toggleCouponStatus(
  id: string,
  adminId: string,
  isActive?: boolean
) {
  const row = await prisma.$transaction(async (tx) => {
    await lockCoupon(tx, id);
    const existing = await tx.coupon.findUniqueOrThrow({ where: { id } });
    return tx.coupon.update({
      where: { id },
      data: {
        isActive: isActive ?? !existing.isActive,
        updatedById: adminId,
      },
      include: COUPON_INCLUDE,
    });
  }, COUPON_TRANSACTION_OPTIONS);

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
  }, COUPON_TRANSACTION_OPTIONS);

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
      { code: { contains: escapeLike(filters.search), mode: "insensitive" } },
      { name: { contains: escapeLike(filters.search), mode: "insensitive" } },
    ];
  }

  const [rows, total] = await prisma.$transaction([
    prisma.coupon.findMany({
      where,
      include: COUPON_INCLUDE,
      // Switched-off coupons (used ones cannot be deleted) sink below the live
      // ones, so the list does not fill up with them; newest first within each. The
      // coupons of one batch share a createdAt, so id keeps the pages stable.
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "asc" }],
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

// ============================================================
// FIND A CUSTOMER FOR A CUSTOMER-ONLY COUPON
// ============================================================

/**
 * Registered users matching a name or email, for choosing who a coupon is
 * reserved for. Searches every account, not only customers who have paid: a
 * coupon is often a welcome offer for someone who has not ordered yet.
 */
export async function searchCouponCustomers(search: string) {
  return prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: escapeLike(search), mode: "insensitive" } },
        { email: { contains: escapeLike(search), mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
    take: 10,
  });
}

// ============================================================
// SWITCH OFF EXPIRED COUPONS
// ============================================================

/**
 * Turns off every active coupon whose end date has passed, so the admin list
 * shows it as off without anyone having to do it by hand. Run on a timer from
 * jobs/workers/index.ts. Checkout does not depend on this: it compares the end
 * date itself, so a coupon is refused the moment it expires even if this has
 * not run yet. Safe to run twice or from two servers (the update only matches
 * coupons that are still on and expired). If an admin extends the end date at
 * the same moment, the database re-checks the condition after the admin's change
 * and leaves the coupon alone.
 *
 * Returns how many coupons were switched off.
 */
export async function sweepExpiredCoupons(): Promise<number> {
  const { count } = await prisma.coupon.updateMany({
    where: { isActive: true, endsAt: { lt: new Date() } },
    data: { isActive: false },
  });
  if (count > 0) logger.info({ count }, "Expired coupons switched off");
  return count;
}
