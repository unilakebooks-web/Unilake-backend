import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import { Prisma } from "../generated/prisma/client.js";
import type {
  DeletionItem,
  DeletionScope,
} from "../generated/prisma/client.js";
import {
  countPrefix,
  deleteKeyChecked,
  isDeletionKey,
  listObjectsPage,
  objectExists,
  pdfKeyFor,
  putObjectChecked,
} from "../lib/r2.js";
import {
  ATTEMPT_GAP_MS,
  BOOK_DELETION_DAYS,
  CANARY_MAX_ATTEMPTS_PER_DAY,
  CANARY_RETRY_GAP_MS,
  CLEAR_VERDICT_MAX_AGE_MS,
  GHOST_MIN_COUNT,
  GHOST_RATE_LIMIT,
  LEASE_STALE_MS,
  MAX_ATTEMPTS,
  PHOTO_DELETION_DAYS,
  PROOF_CANDIDATES,
  PROOF_MIN_AGE_MS,
  STORAGE_CALL_TIMEOUT_MS,
} from "../config/dataDeletion.js";
import {
  isInSessionFolder,
  publicUrlToKey,
  recordedSessionKeys,
} from "../utils/deletionKeys.js";
import {
  deliveredDecision,
  r1Decision,
  type DeletionCandidate,
} from "./dataDeletionSelect.service.js";
import {
  checkRazorpay,
  eventHitRazorpayIds,
  hasFreshClearVerdict,
  linkedPaymentEventCount,
  recordVerdict,
  type RazorpayBudget,
  type RazorpayReader,
} from "./dataDeletionGuard.service.js";
import { lockOrderAddress } from "./orderAddress.service.js";
import { ADDRESS_SYNC_CLAIM_STALE_MS } from "../config/orderAddress.js";

// The deletion engine (feature 6, plan section 3): per item pre-check, claim (locked, re-checked, marker set),
// delete page by page, verify, done. Every storage call has an abort signal, the run has a deadline, and an item
// is re-read before each page so a released or stopped item stops being worked on.

export interface DeletionDeps {
  now: () => Date;
  rzp: RazorpayReader;
  /** Tests only: the selection is limited to one comic's sessions (the test database is shared). */
  onlyComicId?: string;
}

/** The run stops, with a reason the page shows. */
export class RunStop extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** The time budget is used: leave the item CLAIMED (the attempt is refunded) and end the run. */
export class DeadlineStop extends Error {}

/** The claim found something that makes this item not deletable now. */
class ClaimRefused extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export type ItemOutcome =
  | { kind: "done"; deleted: number; ghost: boolean }
  | { kind: "failed"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "refused"; reason: string };

export interface RunCounters {
  claimed: number;
  deleted: number;
  ghosts: number;
  ghostsEvidenced: number;
  failed: number;
  blocked: number;
}

export interface RunContext {
  deps: DeletionDeps;
  /** Hard end of this group's share of the run, in ms since epoch (deps.now). */
  deadlineAt: number;
  razorpayBudget: RazorpayBudget;
  /** Razorpay order ids with a stored payment event (one scan per run, for the candidates). */
  eventHits: Set<string>;
  scanStart: Date;
  proofs: Map<string, "ok" | "none" | "failed">;
  counters: RunCounters;
  /** Failure transitions that make the sweep throw (an item turned FAILED, a stop). */
  transitions: string[];
}

export function createRunContext(
  deps: DeletionDeps,
  deadlineAt: number,
  razorpayCalls: number
): RunContext {
  return {
    deps,
    deadlineAt,
    razorpayBudget: { left: razorpayCalls },
    eventHits: new Set(),
    scanStart: deps.now(),
    proofs: new Map(),
    counters: {
      claimed: 0,
      deleted: 0,
      ghosts: 0,
      ghostsEvidenced: 0,
      failed: 0,
      blocked: 0,
    },
    transitions: [],
  };
}

/** The abort signal every storage call carries. */
export const storageSignal = () => AbortSignal.timeout(STORAGE_CALL_TIMEOUT_MS);
const signal = storageSignal;

/** The two buckets must differ: with one bucket for both, a session folder would hold a customer's photo and its pages. */
export const bucketsAreDistinct = (): boolean =>
  config.r2.publicBucket !== config.r2.privateBucket;

/** Order statuses that show generation reached its end for the order (a bogus photo key cannot have got this far). */
const EVIDENCE_ORDER_STATUSES = [
  "GENERATED",
  "CONFIRMED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
];

function checkDeadline(ctx: RunContext): void {
  if (ctx.deps.now().getTime() >= ctx.deadlineAt) throw new DeadlineStop();
}

/** A storage failure that is the network or the service being down, not this item. */
export function isUnreachable(error: unknown): boolean {
  const err = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (
    ["AbortError", "TimeoutError", "NetworkingError"].includes(err?.name ?? "")
  )
    return true;
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(err?.code ?? "")
  )
    return true;
  const status = err?.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

const sessionInclude = {
  order: {
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      deliveredAt: true,
      pdfUrl: true,
      pdfDeletedAt: true,
      paidAfterDeletionAt: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      supersededRazorpayOrderIds: true,
      billNumber: true,
      couponRedemption: { select: { status: true } },
    },
  },
  pageVersions: {
    select: {
      status: true,
      textStampedUrl: true,
      displayImageUrl: true,
      finalImageUrl: true,
      page: { select: { hasFace: true } },
    },
  },
} satisfies Prisma.OrderSessionInclude;

type LoadedSession = Prisma.OrderSessionGetPayload<{
  include: typeof sessionInclude;
}>;

async function loadSession(id: string): Promise<LoadedSession | null> {
  return prisma.orderSession.findUnique({
    where: { id },
    include: sessionInclude,
  });
}

/** True when the session offers evidence that its photo object really exists (the proof and the ghost rate use it). */
function hasPhotoEvidence(session: LoadedSession): boolean {
  if (
    session.pageVersions.some((v) => v.status === "SD_READY" && v.page.hasFace)
  )
    return true;
  const order = session.order;
  return !!order && EVIDENCE_ORDER_STATUSES.includes(order.status);
}

// ---------------------------------------------------------------------------------------------
// Bucket proof
// ---------------------------------------------------------------------------------------------

export type ProofKind =
  | "private_photo"
  | "public_pages"
  | "pdfs"
  | "comic_public"
  | "comic_private";

async function proofHolds(
  bucket: "public" | "private",
  key: string,
  prefix: string
): Promise<boolean> {
  if (!(await objectExists(bucket, key, signal()))) return false;
  let token: string | undefined;
  do {
    const page = await listObjectsPage(bucket, prefix, token, signal());
    if (page.keys.includes(key)) return true;
    token = page.next;
  } while (token);
  return false;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Proof that a bucket and prefix really hold what the database says: a key of a recent, undeleted session with
 * evidence the object exists must be found by HeadObject and be present in the listing of its own prefix. Up to
 * PROOF_CANDIDATES keys are tried. 'none' means the database offers no candidate (ghosts are then not accepted).
 * A storage fault is thrown (the run stops as unreachable), never read as a missing object.
 */
export async function bucketProof(
  ctx: RunContext,
  kind: ProofKind
): Promise<"ok" | "none" | "failed"> {
  const cached = ctx.proofs.get(kind);
  if (cached) return cached;
  const result = await computeProof(ctx, kind);
  ctx.proofs.set(kind, result);
  return result;
}

async function computeProof(
  ctx: RunContext,
  kind: ProofKind
): Promise<"ok" | "none" | "failed"> {
  const oldEnough = new Date(ctx.deps.now().getTime() - PROOF_MIN_AGE_MS);
  let keys: { bucket: "public" | "private"; key: string; prefix: string }[] =
    [];
  if (kind === "private_photo") {
    const rows = await prisma.orderSession.findMany({
      where: {
        isSample: false,
        photoDeletedAt: null,
        createdAt: { lte: oldEnough },
        bestPhotoUrl: { not: null },
        OR: [
          {
            pageVersions: {
              some: { status: "SD_READY", page: { hasFace: true } },
            },
          },
          {
            order: { is: { status: { in: EVIDENCE_ORDER_STATUSES as never } } },
          },
        ],
      },
      select: { id: true, bestPhotoUrl: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    keys = rows
      .filter((r) => r.bestPhotoUrl && isInSessionFolder(r.id, r.bestPhotoUrl))
      .map((r) => ({
        bucket: "private" as const,
        key: r.bestPhotoUrl as string,
        prefix: `sessions/${r.id}/`,
      }));
  } else if (kind === "public_pages") {
    const rows = await prisma.pageVersion.findMany({
      where: {
        status: "SD_READY",
        finalImageUrl: { not: null },
        orderSession: {
          isSample: false,
          filesDeletedAt: null,
          createdAt: { lte: oldEnough },
        },
      },
      select: { finalImageUrl: true, orderSessionId: true },
      orderBy: { id: "desc" },
      take: 50,
    });
    for (const row of rows) {
      const key = publicUrlToKey(row.finalImageUrl as string);
      if (key && isInSessionFolder(row.orderSessionId, key)) {
        keys.push({
          bucket: "public",
          key,
          prefix: `sessions/${row.orderSessionId}/`,
        });
      }
    }
  } else if (kind === "comic_public") {
    // A comic's own files: the page art of a published comic (the key must be in its own pages folder).
    const rows = await prisma.page.findMany({
      where: {
        artworkUrl: { not: null },
        comic: { status: "PUBLISHED", retiredAt: null },
      },
      select: { comicId: true, artworkUrl: true },
      orderBy: { id: "desc" },
      take: 50,
    });
    for (const row of rows) {
      const key = publicUrlToKey(row.artworkUrl as string);
      if (key && key.startsWith(`comics/${row.comicId}/pages/`)) {
        keys.push({
          bucket: "public",
          key,
          prefix: `comics/${row.comicId}/pages/`,
        });
      }
    }
  } else if (kind === "comic_private") {
    const rows = await prisma.font.findMany({
      where: { comic: { status: "PUBLISHED", retiredAt: null } },
      select: { comicId: true, fileUrl: true },
      orderBy: { id: "desc" },
      take: 50,
    });
    keys = rows
      .filter((r) => r.fileUrl.startsWith(`comics/${r.comicId}/fonts/`))
      .map((r) => ({
        bucket: "private" as const,
        key: r.fileUrl,
        prefix: `comics/${r.comicId}/fonts/`,
      }));
  } else {
    const rows = await prisma.order.findMany({
      where: {
        pdfDeletedAt: null,
        pdfUrl: { not: null },
        createdAt: { lte: oldEnough },
      },
      select: { orderSessionId: true, pdfUrl: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    keys = rows
      .filter((r) => r.pdfUrl === pdfKeyFor(r.orderSessionId))
      .map((r) => ({
        bucket: "public" as const,
        key: r.pdfUrl as string,
        prefix: r.pdfUrl as string,
      }));
  }
  const candidates = shuffled(keys).slice(0, PROOF_CANDIDATES);
  if (candidates.length === 0) return "none";
  for (const candidate of candidates) {
    if (await proofHolds(candidate.bucket, candidate.key, candidate.prefix))
      return "ok";
  }
  return "failed";
}

// ---------------------------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------------------------

const CLAIM_TRANSACTION_OPTIONS = { maxWait: 20_000, timeout: 20_000 };

interface PreCount {
  private?: number;
  public?: number;
}

/**
 * The claim: lock the order row, then the session row (the webhook's order), re-check the whole predicate in the
 * database, set the marker with a raw guarded UPDATE (no updatedAt) and write the item. Returns the item, or a
 * refusal. Throws only on a real failure.
 */
async function claimItem(
  ctx: RunContext,
  candidate: DeletionCandidate,
  preCount: PreCount
): Promise<{ item: DeletionItem } | { refused: string }> {
  const now = ctx.deps.now();
  try {
    const item = await prisma.$transaction(async (tx) => {
      const scope = candidate.scope;
      if (scope === "ADDRESS") {
        return claimAddress(tx, candidate, now);
      }
      const orderId = candidate.orderId;
      const sessionId = candidate.sessionId as string;
      if (scope === "PDF") {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${candidate.subjectId} FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "orderSessionId" = ${sessionId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "order_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
      }
      const session = await tx.orderSession.findUnique({
        where: { id: sessionId },
        include: {
          order: {
            select: {
              id: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              deliveredAt: true,
              pdfUrl: true,
              pdfDeletedAt: true,
              razorpayOrderId: true,
              razorpayPaymentId: true,
              supersededRazorpayOrderIds: true,
              billNumber: true,
              couponRedemption: { select: { status: true } },
            },
          },
          pageVersions: { select: { status: true } },
        },
      });
      if (!session) throw new ClaimRefused("session_gone");
      if (scope === "SESSION") {
        const decision = r1Decision(session, now);
        if (!decision.eligible) throw new ClaimRefused(decision.reason);
        if (session.order) {
          const linked = await linkedPaymentEventCount(session.order.id, tx);
          if (linked > 0) throw new ClaimRefused("payment_event_linked");
          const ids = [
            session.order.razorpayOrderId,
            ...session.order.supersededRazorpayOrderIds,
          ].filter((v): v is string => !!v);
          const hits = await eventHitRazorpayIds(ids, ctx.scanStart, tx);
          if (hits.size > 0) throw new ClaimRefused("payment_event_after_scan");
        } else {
          // No order: re-read inside the lock. An order created while we waited makes us stand down.
          const again = await tx.order.findUnique({
            where: { orderSessionId: sessionId },
            select: { id: true },
          });
          if (again) throw new ClaimRefused("order_appeared");
        }
        await markRaw(tx, "SESSION", sessionId, now);
      } else {
        const order = session.order;
        if (!order) throw new ClaimRefused("no_order");
        const days =
          scope === "PHOTO" ? PHOTO_DELETION_DAYS : BOOK_DELETION_DAYS;
        if (deliveredDecision(order, now, days) !== "due")
          throw new ClaimRefused("not_due_now");
        if (session.isSample) throw new ClaimRefused("sample");
        if (
          session.pageVersions.some(
            (v) => v.status !== "SD_READY" && v.status !== "FAILED"
          )
        ) {
          throw new ClaimRefused("page_version_live");
        }
        if (scope === "PHOTO" && session.photoDeletedAt)
          throw new ClaimRefused("already_marked");
        if (scope === "PAGES" && session.filesDeletedAt)
          throw new ClaimRefused("already_marked");
        if (scope === "PDF") {
          if (order.pdfDeletedAt) throw new ClaimRefused("already_marked");
          if (order.pdfUrl !== pdfKeyFor(sessionId))
            throw new ClaimRefused("pdf_key_differs");
        }
        await markRaw(
          tx,
          scope,
          scope === "PDF" ? (orderId as string) : sessionId,
          now
        );
      }
      return writeClaim(tx, candidate, preCount, now);
    }, CLAIM_TRANSACTION_OPTIONS);
    ctx.counters.claimed += 1;
    return { item };
  } catch (error) {
    if (error instanceof ClaimRefused) return { refused: error.reason };
    throw error;
  }
}

async function markRaw(
  tx: Prisma.TransactionClient,
  scope: DeletionScope,
  id: string,
  now: Date
): Promise<void> {
  let count: number;
  if (scope === "SESSION") {
    count =
      await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${now}, "filesDeletedAt" = ${now} WHERE "id" = ${id} AND "filesDeletedAt" IS NULL`;
  } else if (scope === "PHOTO") {
    count =
      await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${now} WHERE "id" = ${id} AND "photoDeletedAt" IS NULL`;
  } else if (scope === "PAGES") {
    count =
      await tx.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${now} WHERE "id" = ${id} AND "filesDeletedAt" IS NULL`;
  } else {
    count =
      await tx.$executeRaw`UPDATE "orders" SET "pdfDeletedAt" = ${now} WHERE "id" = ${id} AND "pdfDeletedAt" IS NULL`;
  }
  if (count !== 1) throw new ClaimRefused("marker_not_set");
}

async function writeClaim(
  tx: Prisma.TransactionClient,
  candidate: DeletionCandidate,
  preCount: PreCount,
  now: Date
): Promise<DeletionItem> {
  return tx.deletionItem.upsert({
    where: {
      subjectId_scope: {
        subjectId: candidate.subjectId,
        scope: candidate.scope,
      },
    },
    create: {
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      scope: candidate.scope,
      state: "CLAIMED",
      preCount: preCount as Prisma.InputJsonValue,
      attempts: 1,
      lastAttemptAt: now,
      claimedAt: now,
    },
    update: {
      state: "CLAIMED",
      attempts: { increment: 1 },
      lastAttemptAt: now,
    },
  });
}

async function claimAddress(
  tx: Prisma.TransactionClient,
  candidate: DeletionCandidate,
  now: Date
): Promise<DeletionItem> {
  const orderId = candidate.subjectId;
  await lockOrderAddress(tx, orderId);
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, createdAt: true, deliveredAt: true },
  });
  if (!order) throw new ClaimRefused("order_gone");
  if (deliveredDecision(order, now, BOOK_DELETION_DAYS) !== "due") {
    throw new ClaimRefused("not_due_now");
  }
  const fresh = new Date(now.getTime() - ADDRESS_SYNC_CLAIM_STALE_MS);
  const running = await tx.orderAddressChange.count({
    where: { orderId, syncStatus: "SYNCING", syncStartedAt: { gt: fresh } },
  });
  if (running > 0) throw new ClaimRefused("sync_in_progress");
  await tx.$executeRaw`UPDATE "order_address_changes" SET "before" = '{}'::jsonb, "after" = '{}'::jsonb, "syncNote" = NULL WHERE "orderId" = ${orderId}`;
  return tx.deletionItem.upsert({
    where: { subjectId_scope: { subjectId: orderId, scope: "ADDRESS" } },
    create: {
      subjectType: "ORDER",
      subjectId: orderId,
      scope: "ADDRESS",
      state: "DONE",
      attempts: 1,
      lastAttemptAt: now,
      claimedAt: now,
      doneAt: now,
    },
    update: { state: "DONE", doneAt: now },
  });
}

// ---------------------------------------------------------------------------------------------
// Delete and verify
// ---------------------------------------------------------------------------------------------

async function assertStillClaimed(itemId: string): Promise<void> {
  const row = await prisma.deletionItem.findUnique({
    where: { id: itemId },
    select: { state: true },
  });
  if (!row || row.state !== "CLAIMED") throw new DeadlineStop();
}

async function deleteUnderPrefix(
  ctx: RunContext,
  itemId: string,
  bucket: "public" | "private",
  prefix: string
): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    checkDeadline(ctx);
    await assertStillClaimed(itemId);
    const page = await listObjectsPage(bucket, prefix, token, signal());
    for (let i = 0; i < page.keys.length; i += 10) {
      await Promise.all(
        page.keys
          .slice(i, i + 10)
          .map((key) => deleteKeyChecked(bucket, key, signal()))
      );
      deleted += Math.min(10, page.keys.length - i);
    }
    token = page.next;
  } while (token);
  return deleted;
}

/** Marks an item DONE. */
async function finishDone(
  item: DeletionItem,
  now: Date,
  ghost: boolean,
  note?: string
): Promise<void> {
  await prisma.deletionItem.update({
    where: { id: item.id },
    data: { state: "DONE", doneAt: now, ghost, lastError: note ?? null },
  });
}

/** An item error: the attempt counts, the item waits, and after MAX_ATTEMPTS it is FAILED (a transition). */
async function recordItemError(
  ctx: RunContext,
  item: DeletionItem,
  reason: string
): Promise<ItemOutcome> {
  const now = ctx.deps.now();
  const fresh = await prisma.deletionItem.findUnique({
    where: { id: item.id },
  });
  const attempts = fresh?.attempts ?? item.attempts;
  const failed = attempts >= MAX_ATTEMPTS;
  await prisma.deletionItem.update({
    where: { id: item.id },
    data: {
      state: failed ? "FAILED" : "CLAIMED",
      lastErrorAt: now,
      lastError: reason.slice(0, 200),
    },
  });
  if (failed) {
    ctx.counters.failed += 1;
    ctx.transitions.push(`${item.scope} ${item.subjectId} failed: ${reason}`);
  }
  return { kind: "failed", reason };
}

async function failNow(
  ctx: RunContext,
  item: DeletionItem,
  reason: string
): Promise<ItemOutcome> {
  await prisma.deletionItem.update({
    where: { id: item.id },
    data: {
      state: "FAILED",
      lastErrorAt: ctx.deps.now(),
      lastError: reason.slice(0, 200),
    },
  });
  ctx.counters.failed += 1;
  ctx.transitions.push(`${item.scope} ${item.subjectId} failed: ${reason}`);
  return { kind: "failed", reason };
}

/** A deadline stop gives the attempt back (no wait). */
async function refundAttempt(item: DeletionItem): Promise<void> {
  await prisma.deletionItem.updateMany({
    where: { id: item.id, state: "CLAIMED", attempts: { gt: 0 } },
    data: { attempts: { decrement: 1 } },
  });
}

// ---------------------------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------------------------

interface Plan {
  buckets: {
    bucket: "public" | "private";
    prefix: string;
    recorded: string[];
  }[];
  /** Keys recorded outside the item's own folder: if one exists the item is not marked. */
  outside: { bucket: "public" | "private"; key: string }[];
  proofs: ProofKind[];
  /** After the delete, recorded private keys that must be gone (PHOTO). */
  recheck: { bucket: "public" | "private"; key: string }[];
  evidenced: boolean;
}

function buildPlan(
  scope: DeletionScope,
  sessionId: string,
  session: LoadedSession
): Plan {
  const recorded = recordedSessionKeys(session);
  const own = (keys: string[]) =>
    keys.filter((k) => isInSessionFolder(sessionId, k));
  const outsidePrivate = recorded.privateKeys.filter(
    (k) => !isInSessionFolder(sessionId, k)
  );
  const outsidePublic = recorded.publicKeys.filter(
    (k) => !isInSessionFolder(sessionId, k)
  );
  const folder = `sessions/${sessionId}/`;
  const evidenced = hasPhotoEvidence(session);
  if (scope === "PHOTO") {
    return {
      buckets: [
        {
          bucket: "private",
          prefix: `${folder}photo-`,
          recorded: own(recorded.privateKeys),
        },
      ],
      outside: outsidePrivate.map((key) => ({
        bucket: "private" as const,
        key,
      })),
      proofs: ["private_photo"],
      recheck: own(recorded.privateKeys).map((key) => ({
        bucket: "private" as const,
        key,
      })),
      evidenced,
    };
  }
  if (scope === "PAGES") {
    return {
      buckets: [
        {
          bucket: "public",
          prefix: folder,
          recorded: own(recorded.publicKeys),
        },
      ],
      outside: outsidePublic.map((key) => ({ bucket: "public" as const, key })),
      proofs: ["public_pages"],
      recheck: [],
      evidenced,
    };
  }
  // SESSION (R1): both folders.
  return {
    buckets: [
      {
        bucket: "private",
        prefix: folder,
        recorded: own(recorded.privateKeys),
      },
      { bucket: "public", prefix: folder, recorded: own(recorded.publicKeys) },
    ],
    outside: [
      ...outsidePrivate.map((key) => ({ bucket: "private" as const, key })),
      ...outsidePublic.map((key) => ({ bucket: "public" as const, key })),
    ],
    proofs: ["private_photo", "public_pages"],
    recheck: own(recorded.privateKeys).map((key) => ({
      bucket: "private" as const,
      key,
    })),
    evidenced,
  };
}

/** The per-bucket object counts of a plan, and whether the item is a ghost, a mismatch or ordinary. */
async function preCheck(
  ctx: RunContext,
  plan: Plan
): Promise<
  | { kind: "ok"; preCount: PreCount; ghost: boolean }
  | { kind: "blocked"; reason: string }
> {
  const preCount: PreCount = {};
  for (const outside of plan.outside) {
    if (await objectExists(outside.bucket, outside.key, signal())) {
      return { kind: "blocked", reason: "out_of_prefix" };
    }
  }
  let total = 0;
  for (const b of plan.buckets) {
    checkDeadline(ctx);
    const count = await countPrefix(b.bucket, b.prefix, signal());
    preCount[b.bucket] = count;
    total += count;
  }
  if (total > 0) return { kind: "ok", preCount, ghost: false };
  const recordedKeys = plan.buckets.flatMap((b) =>
    b.recorded.map((key) => ({ bucket: b.bucket, key }))
  );
  if (recordedKeys.length === 0) return { kind: "ok", preCount, ghost: false };
  // Listed empty but keys are recorded: a ghost only when no recorded key exists (a failed HeadObject throws).
  for (const rk of recordedKeys) {
    if (await objectExists(rk.bucket, rk.key, signal())) {
      return { kind: "blocked", reason: "listing_mismatch" };
    }
  }
  return { kind: "ok", preCount, ghost: true };
}

async function deleteAndVerify(
  ctx: RunContext,
  item: DeletionItem,
  plan: Plan
): Promise<ItemOutcome> {
  let deleted = 0;
  for (const b of plan.buckets) {
    deleted += await deleteUnderPrefix(ctx, item.id, b.bucket, b.prefix);
  }
  for (const b of plan.buckets) {
    checkDeadline(ctx);
    const left = await countPrefix(b.bucket, b.prefix, signal());
    if (left > 0)
      return failNow(ctx, item, `verify_failed:${b.bucket}:${left}`);
  }
  for (const r of plan.recheck) {
    if (await objectExists(r.bucket, r.key, signal())) {
      return failNow(ctx, item, "recorded_key_left");
    }
  }
  ctx.counters.deleted += deleted;
  await finishDone(item, ctx.deps.now(), false);
  return { kind: "done", deleted, ghost: false };
}

/** Runs an item that is already claimed (new or resumed) through delete, verify and done. */
async function finishClaimedItem(
  ctx: RunContext,
  item: DeletionItem,
  plan: Plan | null,
  ghost: boolean,
  evidenced: boolean
): Promise<ItemOutcome> {
  try {
    if (item.scope === "PDF") {
      const key = pdfKeyFor(await sessionIdOfOrder(item.subjectId));
      checkDeadline(ctx);
      if (await objectExists("public", key, signal())) {
        await deleteKeyChecked("public", key, signal());
        if (await objectExists("public", key, signal()))
          return failNow(ctx, item, "verify_failed:pdf");
        ctx.counters.deleted += 1;
        await finishDone(item, ctx.deps.now(), false);
        return { kind: "done", deleted: 1, ghost: false };
      }
      await finishDone(item, ctx.deps.now(), true, "ghost_pdf");
      ctx.counters.ghosts += 1;
      return { kind: "done", deleted: 0, ghost: true };
    }
    if (!plan) return failNow(ctx, item, "no_plan");
    if (ghost) {
      await finishDone(
        item,
        ctx.deps.now(),
        true,
        evidenced ? "ghost_evidenced" : "ghost_unevidenced"
      );
      ctx.counters.ghosts += 1;
      if (evidenced) ctx.counters.ghostsEvidenced += 1;
      logger.error(
        { scope: item.scope, subjectId: item.subjectId },
        "[Data deletion] a recorded file does not exist (ghost)"
      );
      return { kind: "done", deleted: 0, ghost: true };
    }
    return await deleteAndVerify(ctx, item, plan);
  } catch (error) {
    if (error instanceof DeadlineStop) {
      await refundAttempt(item);
      throw error;
    }
    if (isUnreachable(error)) {
      await refundAttempt(item);
      throw new RunStop("storage_unreachable");
    }
    logger.error(
      { err: error, scope: item.scope, subjectId: item.subjectId },
      "[Data deletion] item failed"
    );
    return recordItemError(
      ctx,
      item,
      error instanceof Error ? error.name : "error"
    );
  }
}

async function sessionIdOfOrder(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderSessionId: true },
  });
  if (!order) throw new Error("order_gone");
  return order.orderSessionId;
}

/** The money guard before a claim of an unpaid preview with a CREATED order. */
async function paymentGuard(
  ctx: RunContext,
  session: LoadedSession
): Promise<
  | { ok: true }
  | { ok: false; kind: "blocked" | "skipped"; reason: string; record: boolean }
> {
  const order = session.order;
  if (!order) return { ok: true };
  const now = ctx.deps.now();
  const decision = r1Decision(session, now);
  if (!decision.needsPaymentCheck) return { ok: true };
  const ids = [
    order.razorpayOrderId,
    ...order.supersededRazorpayOrderIds,
  ].filter((v): v is string => !!v);
  if (ids.some((id) => ctx.eventHits.has(id))) {
    return {
      ok: false,
      kind: "blocked",
      reason: "payment_event_stored",
      record: true,
    };
  }
  if ((await linkedPaymentEventCount(order.id)) > 0) {
    return {
      ok: false,
      kind: "blocked",
      reason: "payment_event_linked",
      record: true,
    };
  }
  if (await hasFreshClearVerdict(order.id, now, CLEAR_VERDICT_MAX_AGE_MS))
    return { ok: true };
  const verdict = await checkRazorpay(
    order,
    now,
    decision.pastCap,
    ctx.razorpayBudget,
    ctx.deps.rzp
  );
  if (verdict.kind === "clear") {
    await recordVerdict(order.id, "clear", now);
    return { ok: true };
  }
  if (verdict.kind === "blocked") {
    return { ok: false, kind: "blocked", reason: verdict.reason, record: true };
  }
  // skip: not asked again for a day, except when only the call budget ran out (the next tick asks again)
  return {
    ok: false,
    kind: "skipped",
    reason: verdict.reason,
    record: verdict.reason !== "not_checked",
  };
}

/** Report-only verdict gathering: runs the money guard for a due preview and stores the verdict, claims nothing. */
export async function gatherPaymentVerdict(
  ctx: RunContext,
  candidate: DeletionCandidate
): Promise<string> {
  const session = await loadSession(candidate.sessionId as string);
  if (!session) return "session_gone";
  const guard = await paymentGuard(ctx, session);
  const subject = session.order?.id ?? session.id;
  if (guard.ok) {
    if (session.order) await recordVerdict(subject, "clear", ctx.deps.now());
    return "clear";
  }
  if (guard.record) await recordVerdict(subject, guard.reason, ctx.deps.now());
  return guard.reason;
}

/** Processes one new due candidate: guard, pre-check, claim, delete, verify. */
export async function processCandidate(
  ctx: RunContext,
  candidate: DeletionCandidate
): Promise<ItemOutcome> {
  checkDeadline(ctx);
  const now = ctx.deps.now();
  try {
    if (candidate.scope === "ADDRESS") {
      const claimed = await claimItem(ctx, candidate, {});
      if ("refused" in claimed)
        return { kind: "refused", reason: claimed.refused };
      return { kind: "done", deleted: 0, ghost: false };
    }
    if (candidate.scope === "PDF") {
      return await processPdf(ctx, candidate);
    }
    const sessionId = candidate.sessionId as string;
    const session = await loadSession(sessionId);
    if (!session) return { kind: "refused", reason: "session_gone" };
    if (candidate.scope === "SESSION") {
      const guard = await paymentGuard(ctx, session);
      if (!guard.ok) {
        if (guard.record)
          await recordVerdict(
            session.order?.id ?? sessionId,
            guard.reason,
            now
          );
        ctx.counters.blocked += 1;
        return { kind: guard.kind, reason: guard.reason };
      }
    }
    const plan = buildPlan(candidate.scope, sessionId, session);
    const check = await preCheck(ctx, plan);
    if (check.kind === "blocked") {
      await recordVerdict(sessionId, check.reason, now);
      ctx.counters.blocked += 1;
      return { kind: "blocked", reason: check.reason };
    }
    let ghost = check.ghost;
    let unproven = false;
    if (ghost) {
      for (const kind of plan.proofs) {
        const touches = plan.buckets.some(
          (b) =>
            b.recorded.length > 0 &&
            (kind === "private_photo") === (b.bucket === "private")
        );
        if (!touches) continue;
        const proof = await bucketProof(ctx, kind);
        if (proof === "failed") throw new RunStop(`proof_failed:${kind}`);
        if (proof === "none") unproven = true;
      }
    }
    const claimed = await claimItem(ctx, candidate, check.preCount);
    if ("refused" in claimed)
      return { kind: "refused", reason: claimed.refused };
    if (ghost && unproven) {
      return failNow(ctx, claimed.item, "ghost_unproven");
    }
    return await finishClaimedItem(
      ctx,
      claimed.item,
      plan,
      ghost,
      plan.evidenced
    );
  } catch (error) {
    if (error instanceof DeadlineStop || error instanceof RunStop) throw error;
    if (isUnreachable(error)) throw new RunStop("storage_unreachable");
    logger.error(
      { err: error, scope: candidate.scope, subjectId: candidate.subjectId },
      "[Data deletion] candidate failed before claim"
    );
    return { kind: "skipped", reason: "error_before_claim" };
  }
}

async function processPdf(
  ctx: RunContext,
  candidate: DeletionCandidate
): Promise<ItemOutcome> {
  const sessionId = candidate.sessionId as string;
  const key = pdfKeyFor(sessionId);
  const exists = await objectExists("public", key, signal());
  if (!exists) {
    const proof = await bucketProof(ctx, "pdfs");
    if (proof === "failed") throw new RunStop("proof_failed:pdfs");
  }
  const claimed = await claimItem(ctx, candidate, { public: exists ? 1 : 0 });
  if ("refused" in claimed) return { kind: "refused", reason: claimed.refused };
  if (!exists && ctx.proofs.get("pdfs") === "none")
    return failNow(ctx, claimed.item, "ghost_unproven");
  return finishClaimedItem(ctx, claimed.item, null, false, false);
}

/** Resumes an item that is CLAIMED (a crash, a deadline stop or an error left it). Returns null when it must wait. */
export async function resumeItem(
  ctx: RunContext,
  item: DeletionItem
): Promise<ItemOutcome | null> {
  const now = ctx.deps.now();
  if (
    item.lastErrorAt &&
    now.getTime() - item.lastErrorAt.getTime() < ATTEMPT_GAP_MS
  )
    return null;
  checkDeadline(ctx);
  // A resumed item re-checks the money: an order that is no longer CREATED, or was paid after deletion, is held.
  if (item.scope === "SESSION") {
    const order = await prisma.order.findUnique({
      where: { orderSessionId: item.subjectId },
      select: { status: true, paidAfterDeletionAt: true },
    });
    if (order && (order.status !== "CREATED" || order.paidAfterDeletionAt)) {
      return failNow(ctx, item, "order_paid_during_deletion");
    }
  }
  try {
    const claimedAgain = await prisma.deletionItem.update({
      where: { id: item.id },
      data: { attempts: { increment: 1 }, lastAttemptAt: now },
    });
    if (claimedAgain.attempts > MAX_ATTEMPTS)
      return failNow(ctx, claimedAgain, "attempts_used_up");
    if (item.scope === "PDF") {
      return await finishClaimedItem(ctx, claimedAgain, null, false, false);
    }
    const sessionId = item.subjectId;
    const session = await loadSession(sessionId);
    if (!session) return failNow(ctx, claimedAgain, "session_gone");
    const plan = buildPlan(item.scope, sessionId, session);
    return await finishClaimedItem(
      ctx,
      claimedAgain,
      plan,
      false,
      plan.evidenced
    );
  } catch (error) {
    if (error instanceof DeadlineStop || error instanceof RunStop) throw error;
    if (isUnreachable(error)) throw new RunStop("storage_unreachable");
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Ghost rate
// ---------------------------------------------------------------------------------------------

/** Whether a group's rolling 24 hours of items hold too many evidenced ghosts. `since` is the later of 24 h ago and the last mode change. */
export async function ghostRateExceeded(
  scopes: DeletionScope[],
  since: Date
): Promise<boolean> {
  const items = await prisma.deletionItem.findMany({
    where: { scope: { in: scopes }, claimedAt: { gte: since } },
    select: { ghost: true, lastError: true },
  });
  if (items.length === 0) return false;
  const evidenced = items.filter(
    (i) => i.ghost && i.lastError === "ghost_evidenced"
  ).length;
  return (
    evidenced >= GHOST_MIN_COUNT && evidenced / items.length > GHOST_RATE_LIMIT
  );
}

// ---------------------------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------------------------

/**
 * A put, list and delete of one object in each bucket. Records the time it passed, and counts the attempt (at most
 * CANARY_MAX_ATTEMPTS_PER_DAY a day, an hour apart, unless `force`: the Master's button). Never throws.
 */
export async function runCanary(
  deps: DeletionDeps,
  force: boolean
): Promise<{ ran: boolean; passed: boolean }> {
  if (!bucketsAreDistinct()) {
    logger.error(
      "[Data deletion] the public and private bucket names are equal: the canary and deletion refuse to run"
    );
    return { ran: false, passed: false };
  }
  const now = deps.now();
  const day = now.toISOString().slice(0, 10);
  const settings = await prisma.deletionSetting.findUniqueOrThrow({
    where: { id: 1 },
  });
  if (!force) {
    const attempts =
      settings.canaryAttemptsDay === day ? settings.canaryAttempts : 0;
    if (attempts >= CANARY_MAX_ATTEMPTS_PER_DAY)
      return { ran: false, passed: false };
    if (
      settings.canaryAttemptedAt &&
      now.getTime() - settings.canaryAttemptedAt.getTime() < CANARY_RETRY_GAP_MS
    ) {
      return { ran: false, passed: false };
    }
  }
  const attemptsToday =
    (settings.canaryAttemptsDay === day ? settings.canaryAttempts : 0) + 1;
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: {
      canaryAttemptedAt: now,
      canaryAttemptsDay: day,
      canaryAttempts: attemptsToday,
    },
  });
  let passed = true;
  const folder = `sessions/${randomUUID()}/`;
  const key = `${folder}canary`;
  for (const bucket of ["private", "public"] as const) {
    try {
      await putObjectChecked(bucket, key, Buffer.from("canary"), signal());
      const listed = (
        await listObjectsPage(bucket, folder, undefined, signal())
      ).keys;
      if (!listed.includes(key)) throw new Error("canary_not_listed");
      await deleteKeyChecked(bucket, key, signal());
      if (await objectExists(bucket, key, signal()))
        throw new Error("canary_not_deleted");
    } catch (error) {
      passed = false;
      logger.error({ err: error, bucket }, "[Data deletion] the canary failed");
    }
  }
  if (passed) {
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { canaryPassedAt: deps.now() },
    });
  }
  return { ran: true, passed };
}

// ---------------------------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------------------------

/** Takes the run lease (one run at a time across instances). Returns the owner token, or null when a run is live. */
export async function acquireLease(deps: DeletionDeps): Promise<string | null> {
  const owner = randomUUID();
  const now = deps.now();
  const taken = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('data-deletion-lease'))`;
    const row = await tx.deletionSetting.findUniqueOrThrow({
      where: { id: 1 },
    });
    if (row.leaseUntil && row.leaseUntil.getTime() > now.getTime())
      return false;
    await tx.deletionSetting.update({
      where: { id: 1 },
      data: {
        leaseUntil: new Date(now.getTime() + LEASE_STALE_MS),
        leaseOwner: owner,
      },
    });
    return true;
  });
  return taken ? owner : null;
}

export async function releaseLease(owner: string): Promise<void> {
  await prisma.deletionSetting.updateMany({
    where: { id: 1, leaseOwner: owner },
    data: { leaseUntil: null, leaseOwner: null },
  });
}

/** True while this process still owns the lease (a stalled run that resumes after a takeover must stop). */
export async function stillOwnsLease(owner: string): Promise<boolean> {
  const row = await prisma.deletionSetting.findUnique({
    where: { id: 1 },
    select: { leaseOwner: true },
  });
  return row?.leaseOwner === owner;
}

// ---------------------------------------------------------------------------------------------
// A retired comic's files (scope COMIC)
// ---------------------------------------------------------------------------------------------

/** Whether another row refers to this key (in URL or key form), so deleting it would break something that is kept. */
async function keyReferencedElsewhere(
  comicId: string,
  bucket: "public" | "private",
  key: string
): Promise<boolean> {
  // Thumbnails are never deleted, and they are a list of URLs: any comic, this one included, naming the key keeps it.
  const thumbs = await prisma.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM "comics" c
    WHERE EXISTS (SELECT 1 FROM unnest(c."coverThumbnailUrls") u WHERE u LIKE ${"%" + key})
    LIMIT 1`;
  if (thumbs.length > 0) return true;
  if (bucket === "public") {
    const pages = await prisma.page.count({
      where: {
        comicId: { not: comicId },
        OR: [{ artworkUrl: { endsWith: key } }, { maskUrl: { endsWith: key } }],
      },
    });
    if (pages > 0) return true;
    const videos = await prisma.comic.count({
      where: { id: { not: comicId }, previewVideoUrl: { endsWith: key } },
    });
    return videos > 0;
  }
  const lora = await prisma.comic.count({
    where: { id: { not: comicId }, loraFileUrl: key },
  });
  if (lora > 0) return true;
  const fonts = await prisma.font.count({
    where: { comicId: { not: comicId }, fileUrl: key },
  });
  return fonts > 0;
}

/**
 * Deletes a retired comic's own files: page art and masks and the video (public), fonts and the LoRA file (private).
 * Exact keys only, never a folder listing: the video and LoRA folders are shared between comics. Thumbnails are never
 * deleted. A key that another row refers to is kept; a URL under an unknown host or outside the allow-list is kept
 * and does not block; an absent key counts as gone once the bucket proof passes. Returns null while the item waits.
 */
export async function processComicItem(
  ctx: RunContext,
  item: DeletionItem
): Promise<ItemOutcome | null> {
  const now = ctx.deps.now();
  if (
    item.lastErrorAt &&
    now.getTime() - item.lastErrorAt.getTime() < ATTEMPT_GAP_MS
  )
    return null;
  checkDeadline(ctx);
  const comicId = item.subjectId;
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { status: string; retiredAt: Date | null; filesDeletedAt: Date | null }[]
    >`SELECT "status", "retiredAt", "filesDeletedAt" FROM "comics" WHERE "id" = ${comicId} FOR UPDATE`;
    const comic = rows[0];
    if (!comic || !comic.retiredAt || comic.status === "PUBLISHED")
      return "refused" as const;
    if (comic.filesDeletedAt) return "already" as const;
    await tx.deletionItem.update({
      where: { id: item.id },
      data: { attempts: { increment: 1 }, lastAttemptAt: now },
    });
    return "claimed" as const;
  });
  if (claimed === "refused") return failNow(ctx, item, "comic_not_retired");
  if (claimed === "already") {
    await finishDone(item, now, false, "already_gone");
    return { kind: "done", deleted: 0, ghost: false };
  }
  try {
    const comic = await prisma.comic.findUniqueOrThrow({
      where: { id: comicId },
      select: {
        previewVideoUrl: true,
        loraFileUrl: true,
        pages: { select: { artworkUrl: true, maskUrl: true } },
        fonts: { select: { fileUrl: true } },
      },
    });
    const targets: { bucket: "public" | "private"; key: string }[] = [];
    let kept = 0;
    const addPublic = (url: string | null) => {
      if (!url) return;
      const key = publicUrlToKey(url);
      if (key && isDeletionKey(key)) targets.push({ bucket: "public", key });
      else kept += 1;
    };
    for (const page of comic.pages) {
      addPublic(page.artworkUrl);
      addPublic(page.maskUrl);
    }
    addPublic(comic.previewVideoUrl);
    for (const font of comic.fonts) {
      if (font.fileUrl && isDeletionKey(font.fileUrl))
        targets.push({ bucket: "private", key: font.fileUrl });
      else kept += 1;
    }
    if (comic.loraFileUrl) {
      if (isDeletionKey(comic.loraFileUrl))
        targets.push({ bucket: "private", key: comic.loraFileUrl });
      else kept += 1;
    }
    let deleted = 0;
    const absent: { bucket: "public" | "private"; key: string }[] = [];
    for (const target of new Map(
      targets.map((t) => [`${t.bucket}:${t.key}`, t])
    ).values()) {
      checkDeadline(ctx);
      if (await keyReferencedElsewhere(comicId, target.bucket, target.key)) {
        kept += 1;
        continue;
      }
      if (await objectExists(target.bucket, target.key, signal())) {
        await deleteKeyChecked(target.bucket, target.key, signal());
        if (await objectExists(target.bucket, target.key, signal())) {
          return failNow(ctx, item, `verify_failed:${target.key.slice(0, 60)}`);
        }
        deleted += 1;
      } else {
        absent.push(target);
      }
    }
    if (absent.length > 0) {
      const needsPublic = absent.some((a) => a.bucket === "public");
      const needsPrivate = absent.some((a) => a.bucket === "private");
      if (needsPublic && (await bucketProof(ctx, "comic_public")) === "failed")
        throw new RunStop("proof_failed:comic_public");
      if (
        needsPrivate &&
        (await bucketProof(ctx, "comic_private")) === "failed"
      )
        throw new RunStop("proof_failed:comic_private");
      if (
        (needsPublic && ctx.proofs.get("comic_public") === "none") ||
        (needsPrivate && ctx.proofs.get("comic_private") === "none")
      ) {
        return failNow(ctx, item, "ghost_unproven");
      }
    }
    await prisma.$executeRaw`UPDATE "comics" SET "filesDeletedAt" = ${ctx.deps.now()} WHERE "id" = ${comicId} AND "filesDeletedAt" IS NULL`;
    ctx.counters.deleted += deleted;
    await finishDone(
      item,
      ctx.deps.now(),
      false,
      `kept:${kept},absent:${absent.length}`
    );
    return { kind: "done", deleted, ghost: false };
  } catch (error) {
    if (error instanceof DeadlineStop) {
      await refundAttempt(item);
      throw error;
    }
    if (error instanceof RunStop) throw error;
    if (isUnreachable(error)) {
      await refundAttempt(item);
      throw new RunStop("storage_unreachable");
    }
    logger.error(
      { err: error, comicId },
      "[Data deletion] a retired comic's files failed"
    );
    return recordItemError(
      ctx,
      item,
      error instanceof Error ? error.name : "error"
    );
  }
}
