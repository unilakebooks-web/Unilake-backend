import { prisma } from "../lib/prisma.js";
import type {
  DeletionGroup,
  DeletionScope,
  DeletionSubjectType,
  OrderSessionStatus,
} from "../generated/prisma/client.js";
import { EXPIRY_EXEMPT_STATUSES } from "./session.service.js";
import { ADDRESS_SYNC_CLAIM_STALE_MS } from "../config/orderAddress.js";
import {
  BOOK_DELETION_DAYS,
  DAY_MS,
  DELETION_MARGIN_MS,
  DELIVERED_FUTURE_TOLERANCE_MS,
  ORDER_SETTLE_MS,
  PHOTO_DELETION_DAYS,
  PREVIEW_DELETION_DELAY_MS,
  PREVIEW_MAX_EXTRA_MS,
  REPORT_ID_CAP,
} from "../config/dataDeletion.js";
import { pdfKeyFor } from "../lib/r2.js";

// Which sessions and orders each deletion group picks (feature 6, plan section 1). The report and the real run
// both use selectDue, and the claim re-checks the same pure predicates inside its lock, so the report is what a
// run does. Every function takes `now`: tests drive every boundary with a passed clock.

export interface DeletionCandidate {
  group: DeletionGroup;
  scope: DeletionScope;
  subjectType: DeletionSubjectType;
  /** The session id (SESSION, PHOTO, PAGES), the order id (PDF, ADDRESS) or the comic id (COMIC). */
  subjectId: string;
  sessionId: string | null;
  orderId: string | null;
  dueAt: Date;
}

/** Lists the report shows besides the due items (ids only). */
export interface SelectionLists {
  failedClock: string[];
  legacyPdf: string[];
  /** Orders that are CANCELLED or SHIPROCKET_FAILED: never deleted, listed (D-079). */
  keptOrders: string[];
  /** Sessions skipped because a verdict blocks them (payment in progress, out of prefix, unknown order...). */
  blocked: string[];
}

export const isLiveVersionStatus = (status: string): boolean =>
  status !== "SD_READY" && status !== "FAILED";

/** Session statuses a `CREATED` order's session may have for R1 (anything else is listed, not deleted). */
const R1_CREATED_ORDER_SESSION_STATUSES: OrderSessionStatus[] = [
  "PREVIEW_READY",
  "AWAITING_PAYMENT",
  "FAILED",
  "GENERATING_PREVIEW",
];

export interface R1Session {
  id: string;
  status: OrderSessionStatus;
  isSample: boolean;
  filesDeletedAt: Date | null;
  expiresAt: Date;
  pageVersions: { status: string }[];
  order: {
    status: string;
    updatedAt: Date;
    razorpayPaymentId: string | null;
    billNumber: string | null;
    couponRedemption: { status: string } | null;
  } | null;
}

export interface R1Decision {
  eligible: boolean;
  reason: string;
  /** The order is CREATED: the money guard (stored events, Razorpay) must clear it. */
  needsPaymentCheck: boolean;
  /** Past `expiresAt` + 3 days: the 2-day clock and the Razorpay recency rule no longer hold it back. */
  pastCap: boolean;
}

const no = (reason: string): R1Decision => ({
  eligible: false,
  reason,
  needsPaymentCheck: false,
  pastCap: false,
});

/** R1: is this unpaid preview due for deletion now (database part of the money guard included)? */
export function r1Decision(session: R1Session, now: Date): R1Decision {
  if (session.isSample) return no("sample");
  if (session.filesDeletedAt) return no("already_marked");
  if (session.expiresAt.getTime() + PREVIEW_DELETION_DELAY_MS > now.getTime()) {
    return no("not_due");
  }
  if (session.pageVersions.some((v) => isLiveVersionStatus(v.status))) {
    return no("page_version_live");
  }
  const order = session.order;
  if (!order) {
    if (EXPIRY_EXEMPT_STATUSES.includes(session.status)) {
      return no("status_exempt_without_order");
    }
    return {
      eligible: true,
      reason: "no_order",
      needsPaymentCheck: false,
      pastCap: false,
    };
  }
  if (order.status !== "CREATED") return no(`order_${order.status}`);
  if (!R1_CREATED_ORDER_SESSION_STATUSES.includes(session.status)) {
    return no(`session_status_${session.status}`);
  }
  const pastCap =
    now.getTime() >= session.expiresAt.getTime() + PREVIEW_MAX_EXTRA_MS;
  if (!pastCap && order.updatedAt.getTime() + ORDER_SETTLE_MS > now.getTime()) {
    return no("order_recently_touched");
  }
  if (order.razorpayPaymentId) return no("payment_id");
  if (order.billNumber) return no("bill_number");
  if (order.couponRedemption?.status === "REDEEMED")
    return no("coupon_redeemed");
  return {
    eligible: true,
    reason: "created_order",
    needsPaymentCheck: true,
    pastCap,
  };
}

export type DeliveredClock = "due" | "not_due" | "failed_clock";

/** R2 to R5: the delivery clock of an order (`days` after delivery, plus the margin). */
export function deliveredDecision(
  order: { status: string; createdAt: Date; deliveredAt: Date | null },
  now: Date,
  days: number
): DeliveredClock {
  if (order.status !== "DELIVERED") return "not_due";
  const delivered = order.deliveredAt;
  if (!delivered) return "failed_clock";
  if (delivered.getTime() < order.createdAt.getTime()) return "failed_clock";
  if (delivered.getTime() > now.getTime() + DELIVERED_FUTURE_TOLERANCE_MS) {
    return "failed_clock";
  }
  return delivered.getTime() + days * DAY_MS + DELETION_MARGIN_MS <=
    now.getTime()
    ? "due"
    : "not_due";
}

const BOOK_DELETION_DAYS_MS = BOOK_DELETION_DAYS * DAY_MS;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/** Sessions or orders a verdict blocks for now (not clear), so they are not read again every tick. */
async function blockedSubjectIds(
  now: Date,
  ttlMs: number
): Promise<Set<string>> {
  const rows = await prisma.deletionBlock.findMany({
    where: {
      reason: { not: "clear" },
      checkedAt: { gt: new Date(now.getTime() - ttlMs) },
    },
    select: { subjectId: true },
  });
  return new Set(rows.map((row) => row.subjectId));
}

export interface SelectOptions {
  /** The most candidates to return (the report asks for REPORT_ID_CAP, a run for what it can still do). */
  limit: number;
  /** A verdict blocks a subject for this long. */
  blockTtlMs: number;
  /** Tests only: restrict the selection to the sessions of one comic (the test database is shared). */
  onlyComicId?: string;
}

export interface Selection {
  candidates: DeletionCandidate[];
  lists: SelectionLists;
}

const emptyLists = (): SelectionLists => ({
  failedClock: [],
  legacyPdf: [],
  keptOrders: [],
  blocked: [],
});

/** Takes one item from each list in turn until all are used. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i] as T);
  }
  return out;
}

/** The items of a group that are due now, oldest first. */
export async function selectDue(
  group: DeletionGroup,
  now: Date,
  options: SelectOptions
): Promise<Selection> {
  const blocked = await blockedSubjectIds(now, options.blockTtlMs);
  if (group === "PREVIEWS") return selectPreviews(now, options, blocked);
  if (group === "PHOTOS")
    return selectDelivered(group, "PHOTO", now, options, blocked);
  const pages = await selectDelivered(group, "PAGES", now, options, blocked);
  const pdf = await selectDelivered(group, "PDF", now, options, blocked);
  const address = await selectAddress(now, options);
  return {
    // One of each in turn, so a long backlog of one scope cannot hold the others back past their own days.
    candidates: interleave([pages.candidates, pdf.candidates, address]).slice(
      0,
      Math.max(options.limit, 0)
    ),
    lists: {
      failedClock: [
        ...new Set([...pages.lists.failedClock, ...pdf.lists.failedClock]),
      ],
      legacyPdf: pdf.lists.legacyPdf,
      keptOrders: pages.lists.keptOrders,
      blocked: [...new Set([...pages.lists.blocked, ...pdf.lists.blocked])],
    },
  };
}

async function selectPreviews(
  now: Date,
  options: SelectOptions,
  blocked: Set<string>
): Promise<Selection> {
  const lists = emptyLists();
  const candidates: DeletionCandidate[] = [];
  let cursor: string | undefined;
  for (
    let page = 0;
    page < MAX_PAGES && candidates.length < options.limit;
    page++
  ) {
    const rows = await prisma.orderSession.findMany({
      where: {
        isSample: false,
        filesDeletedAt: null,
        expiresAt: { lte: new Date(now.getTime() - PREVIEW_DELETION_DELAY_MS) },
        ...(options.onlyComicId ? { comicId: options.onlyComicId } : {}),
        pageVersions: { none: { status: { notIn: ["SD_READY", "FAILED"] } } },
        OR: [{ order: null }, { order: { status: "CREATED" } }],
      },
      select: {
        id: true,
        status: true,
        isSample: true,
        filesDeletedAt: true,
        expiresAt: true,
        order: {
          select: {
            id: true,
            status: true,
            updatedAt: true,
            razorpayPaymentId: true,
            billNumber: true,
            couponRedemption: { select: { status: true } },
          },
        },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      if (blocked.has(row.id) || (row.order && blocked.has(row.order.id))) {
        lists.blocked.push(row.id);
        continue;
      }
      const decision = r1Decision({ ...row, pageVersions: [] }, now);
      if (!decision.eligible) continue;
      candidates.push({
        group: "PREVIEWS",
        scope: "SESSION",
        subjectType: "SESSION",
        subjectId: row.id,
        sessionId: row.id,
        orderId: row.order?.id ?? null,
        dueAt: row.expiresAt,
      });
      if (candidates.length >= options.limit) break;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { candidates, lists };
}

async function selectDelivered(
  group: DeletionGroup,
  scope: "PHOTO" | "PAGES" | "PDF",
  now: Date,
  options: SelectOptions,
  blocked: Set<string>
): Promise<Selection> {
  const lists = emptyLists();
  const candidates: DeletionCandidate[] = [];
  const days = scope === "PHOTO" ? PHOTO_DELETION_DAYS : BOOK_DELETION_DAYS;
  const cutoff = new Date(now.getTime() - days * DAY_MS - DELETION_MARGIN_MS);
  const sessionMarker =
    scope === "PHOTO"
      ? { photoDeletedAt: null }
      : scope === "PAGES"
        ? { filesDeletedAt: null }
        : {};
  let cursor: string | undefined;
  for (
    let page = 0;
    page < MAX_PAGES && candidates.length < options.limit;
    page++
  ) {
    const rows = await prisma.order.findMany({
      where: {
        status: "DELIVERED",
        deliveredAt: { not: null, lte: cutoff },
        ...(scope === "PDF"
          ? { pdfDeletedAt: null, pdfUrl: { not: null } }
          : {}),
        orderSession: {
          isSample: false,
          ...(options.onlyComicId ? { comicId: options.onlyComicId } : {}),
          ...sessionMarker,
          pageVersions: { none: { status: { notIn: ["SD_READY", "FAILED"] } } },
        },
      },
      select: {
        id: true,
        orderSessionId: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        pdfUrl: true,
      },
      orderBy: [{ deliveredAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const clock = deliveredDecision(row, now, days);
      if (clock === "failed_clock") {
        lists.failedClock.push(row.id);
        continue;
      }
      if (clock !== "due") continue;
      const subject = scope === "PDF" ? row.id : row.orderSessionId;
      if (blocked.has(subject) || blocked.has(row.id)) {
        lists.blocked.push(subject);
        continue;
      }
      if (scope === "PDF" && row.pdfUrl !== pdfKeyFor(row.orderSessionId)) {
        lists.legacyPdf.push(row.id);
        continue;
      }
      candidates.push({
        group,
        scope,
        subjectType: scope === "PDF" ? "ORDER" : "SESSION",
        subjectId: subject,
        sessionId: row.orderSessionId,
        orderId: row.id,
        dueAt: row.deliveredAt as Date,
      });
      if (candidates.length >= options.limit) break;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { candidates, lists };
}

/** R5: delivered orders (45 days) with an address-change row that still holds an address. */
async function selectAddress(
  now: Date,
  options: SelectOptions
): Promise<DeletionCandidate[]> {
  const cutoff = new Date(
    now.getTime() - BOOK_DELETION_DAYS_MS - DELETION_MARGIN_MS
  );
  const futureLimit = new Date(now.getTime() + DELIVERED_FUTURE_TOLERANCE_MS);
  const freshSyncing = new Date(now.getTime() - ADDRESS_SYNC_CLAIM_STALE_MS);
  const rows = await prisma.$queryRaw<
    { id: string; orderSessionId: string; deliveredAt: Date }[]
  >`
    SELECT o."id", o."orderSessionId", o."deliveredAt"
    FROM "orders" o
    WHERE o."status" = 'DELIVERED'
      AND o."deliveredAt" IS NOT NULL
      AND o."deliveredAt" <= ${cutoff}
      AND o."deliveredAt" >= o."createdAt"
      AND o."deliveredAt" <= ${futureLimit}
      AND EXISTS (
        SELECT 1 FROM "order_address_changes" c
        WHERE c."orderId" = o."id"
          AND (c."before" <> '{}'::jsonb OR c."after" <> '{}'::jsonb OR c."syncNote" IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM "order_address_changes" c2
        WHERE c2."orderId" = o."id"
          AND c2."syncStatus" = 'SYNCING'
          AND c2."syncStartedAt" > ${freshSyncing}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "deletion_items" i
        WHERE i."subjectId" = o."id" AND i."scope" = 'ADDRESS'
      )
      AND (${options.onlyComicId ?? null}::text IS NULL OR EXISTS (
        SELECT 1 FROM "order_sessions" s
        WHERE s."id" = o."orderSessionId" AND s."comicId" = ${options.onlyComicId ?? null}::text
      ))
    ORDER BY o."deliveredAt" ASC
    LIMIT ${Math.max(options.limit, 0)}
  `;
  return rows.map((row) => ({
    group: "BOOKS" as const,
    scope: "ADDRESS" as const,
    subjectType: "ORDER" as const,
    subjectId: row.id,
    sessionId: row.orderSessionId,
    orderId: row.id,
    dueAt: row.deliveredAt,
  }));
}

/** Report lists that need their own queries: delivered orders with an unusable delivery clock, and kept orders. */
export async function selectReportLists(now: Date): Promise<{
  failedClock: string[];
  keptOrders: string[];
}> {
  const futureLimit = new Date(now.getTime() + DELIVERED_FUTURE_TOLERANCE_MS);
  const failed = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "orders"
    WHERE "status" = 'DELIVERED'
      AND ("deliveredAt" IS NULL OR "deliveredAt" < "createdAt" OR "deliveredAt" > ${futureLimit})
    LIMIT ${REPORT_ID_CAP}
  `;
  const kept = await prisma.order.findMany({
    where: { status: { in: ["CANCELLED", "SHIPROCKET_FAILED"] } },
    select: { id: true },
    take: REPORT_ID_CAP,
  });
  return {
    failedClock: failed.map((r) => r.id),
    keptOrders: kept.map((r) => r.id),
  };
}
