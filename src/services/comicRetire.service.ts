import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type { ComicStatus } from "../generated/prisma/client.js";
import { ConflictError } from "../utils/errors.js";
import { COMIC_DELETE_AFTER_DAYS, DAY_MS } from "../config/dataDeletion.js";
import { REPORTING_TIMEZONE } from "../config/stats.js";

// Deleting an unpublished comic (feature 6, R6, D-081 and D-094). A comic nobody ever bought is deleted for good as
// before, once it has been unpublished for 30 days. A comic that has sessions or orders cannot be deleted (they keep
// reading it), so it is retired instead: nothing may change it any more, its own files are deleted by the BOOKS
// deletion sweep (exact keys only, never thumbnails), and its rows stay.

export interface DeleteEligibility {
  canDelete: boolean;
  /** "delete" removes the comic for good, "retire" keeps its rows, "retired" is already retired, "blocked" cannot yet. */
  kind: "delete" | "retire" | "retired" | "blocked";
  reason: string | null;
}

export interface EligibilityComic {
  id: string;
  status: ComicStatus;
  unpublishedAt: Date | null;
  retiredAt: Date | null;
  filesDeletedAt: Date | null;
}

const dateText = (date: Date) =>
  date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: REPORTING_TIMEZONE,
  });

/**
 * The 30-day rule: a comic that was unpublished (UNPUBLISHED, or a DRAFT that was published once) can be deleted or
 * retired only 30 days after `unpublishedAt`. A never-published DRAFT has no such date and is unchanged. Null when
 * the comic may go ahead, otherwise the reason.
 */
export function monthRuleReason(
  comic: Pick<EligibilityComic, "status" | "unpublishedAt">,
  now: Date
): string | null {
  const applies =
    comic.status === "UNPUBLISHED" ||
    (comic.status === "DRAFT" && comic.unpublishedAt !== null);
  if (!applies) return null;
  if (!comic.unpublishedAt) {
    return "it has no unpublish date yet, so it cannot be deleted";
  }
  const from = new Date(
    comic.unpublishedAt.getTime() + COMIC_DELETE_AFTER_DAYS * DAY_MS
  );
  if (now.getTime() < from.getTime()) {
    return `a comic can be deleted ${COMIC_DELETE_AFTER_DAYS} days after it was unpublished, from ${dateText(from)}`;
  }
  return null;
}

/** Sessions that do not stop a retire: delivered with files gone, cancelled, or unpaid with files gone. */
export const SETTLED_SESSION: Prisma.OrderSessionWhereInput = {
  OR: [
    { filesDeletedAt: { not: null }, order: { is: { status: "DELIVERED" } } },
    { order: { is: { status: "CANCELLED" } } },
    {
      filesDeletedAt: { not: null },
      OR: [{ order: { is: null } }, { order: { is: { status: "CREATED" } } }],
    },
  ],
};

/**
 * Works out, for a batch of comics and in a handful of queries (never one per row), what the delete button may do.
 * The existing guards (published, live or ending samples, active sessions) keep their own messages in deleteComic;
 * this gives the admin list a reason for each row.
 */
export async function deleteEligibilityForComics(
  comics: EligibilityComic[],
  now: Date
): Promise<Map<string, DeleteEligibility>> {
  const result = new Map<string, DeleteEligibility>();
  const open = comics.filter(
    (c) => !c.retiredAt && c.status !== "PUBLISHED" && c.status !== "PUBLISHING"
  );
  const ids = open.map((c) => c.id);
  type Counts = { comicId: string; _count: { _all: number } }[];
  let sessionCounts: Counts = [];
  let unsettled: Counts = [];
  let samples: Counts = [];
  let coupons: Counts = [];
  let booksMode: string | null = null;
  if (ids.length > 0) {
    [sessionCounts, unsettled, samples, coupons, booksMode] = await Promise.all(
      [
        prisma.orderSession.groupBy({
          by: ["comicId"],
          where: { comicId: { in: ids }, isSample: false },
          _count: { _all: true },
        }),
        prisma.orderSession.groupBy({
          by: ["comicId"],
          where: {
            comicId: { in: ids },
            isSample: false,
            NOT: SETTLED_SESSION,
          },
          _count: { _all: true },
        }),
        prisma.orderSession.groupBy({
          by: ["comicId"],
          where: { comicId: { in: ids }, isSample: true },
          _count: { _all: true },
        }),
        prisma.couponComic.groupBy({
          by: ["comicId"],
          where: { comicId: { in: ids }, coupon: { isActive: true } },
          _count: { _all: true },
        }),
        prisma.deletionGroupSetting
          .findUnique({ where: { group: "BOOKS" }, select: { mode: true } })
          .then((row) => row?.mode ?? null),
      ]
    );
  }
  const countOf = (rows: Counts, id: string) =>
    rows.find((r) => r.comicId === id)?._count._all ?? 0;

  for (const comic of comics) {
    if (comic.retiredAt) {
      result.set(comic.id, {
        canDelete: false,
        kind: "retired",
        reason: comic.filesDeletedAt
          ? "Retired: its files were deleted"
          : "Retired: its files are being deleted",
      });
      continue;
    }
    if (comic.status === "PUBLISHED" || comic.status === "PUBLISHING") {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: "Unpublish it first",
      });
      continue;
    }
    const month = monthRuleReason(comic, now);
    if (month) {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: `Not yet: ${month}`,
      });
      continue;
    }
    const sampleCount = countOf(samples, comic.id);
    if (sampleCount > 0) {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: `${sampleCount} sample book(s) of it still exist`,
      });
      continue;
    }
    const total = countOf(sessionCounts, comic.id);
    if (total === 0) {
      result.set(comic.id, { canDelete: true, kind: "delete", reason: null });
      continue;
    }
    if (comic.status !== "UNPUBLISHED") {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: "It has previews or orders",
      });
      continue;
    }
    const couponCount = countOf(coupons, comic.id);
    if (couponCount > 0) {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: `${couponCount} active coupon(s) name it: switch them off first`,
      });
      continue;
    }
    const unsettledCount = countOf(unsettled, comic.id);
    if (unsettledCount > 0) {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason: `${unsettledCount} preview(s) or order(s) are still live, or their files are not deleted yet`,
      });
      continue;
    }
    if (booksMode !== "ACTIVE") {
      result.set(comic.id, {
        canDelete: false,
        kind: "blocked",
        reason:
          "Automatic deletion of books must be switched on (Data deletion page) before a comic with orders can be retired",
      });
      continue;
    }
    result.set(comic.id, { canDelete: true, kind: "retire", reason: null });
  }
  return result;
}

/**
 * Retires a comic: locks its row, re-checks, sets `retiredAt` and creates the COMIC deletion item (the BOOKS sweep
 * deletes the files later). Every status write on a comic is guarded `WHERE "retiredAt" IS NULL`, so a publish
 * racing this cannot win either way round.
 */
export async function retireComic(comicId: string, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { status: ComicStatus; retiredAt: Date | null }[]
    >`
      SELECT "status", "retiredAt" FROM "comics" WHERE "id" = ${comicId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new ConflictError("Comic not found.");
    if (row.retiredAt)
      throw new ConflictError("This comic is already retired.");
    if (row.status !== "UNPUBLISHED") {
      throw new ConflictError("Only an unpublished comic can be retired.");
    }
    // The rest of the eligibility, again under the lock: nothing may have changed since the delete button was pressed.
    const unsettled = await tx.orderSession.count({
      where: { comicId, isSample: false, NOT: SETTLED_SESSION },
    });
    if (unsettled > 0)
      throw new ConflictError(
        "A preview or order of this comic is still live, or its files are not deleted yet."
      );
    const coupons = await tx.couponComic.count({
      where: { comicId, coupon: { isActive: true } },
    });
    if (coupons > 0)
      throw new ConflictError(
        "An active coupon names this comic: switch it off first."
      );
    const books = await tx.deletionGroupSetting.findUnique({
      where: { group: "BOOKS" },
      select: { mode: true },
    });
    if (books?.mode !== "ACTIVE")
      throw new ConflictError(
        "Automatic deletion of books must be switched on before a comic can be retired."
      );
    await tx.$executeRaw`UPDATE "comics" SET "retiredAt" = ${now} WHERE "id" = ${comicId} AND "retiredAt" IS NULL`;
    await tx.deletionItem.upsert({
      where: { subjectId_scope: { subjectId: comicId, scope: "COMIC" } },
      create: {
        subjectType: "COMIC",
        subjectId: comicId,
        scope: "COMIC",
        state: "CLAIMED",
        claimedAt: now,
      },
      update: {},
    });
  });
}
