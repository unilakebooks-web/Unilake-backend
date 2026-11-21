import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";
import type {
  DeletionGroup,
  DeletionMode,
  DeletionScope,
} from "../generated/prisma/client.js";
import {
  APPROVAL_WINDOW_MS,
  BACKLOG_ERROR_AFTER_MS,
  CANARY_AUTO_INTERVAL_MS,
  CANARY_VALID_MS,
  DAILY_MAX_LIMIT,
  DAY_MS,
  DELETION_ITEM_RETENTION_DAYS,
  DELETION_RUN_BUDGET_MS,
  DELETION_RUN_RETENTION_DAYS,
  RAZORPAY_CALLS_PER_RUN,
  RAZORPAY_VERDICT_TTL_MS,
  REPORT_ID_CAP,
  REPORT_SAMPLE_SIZE,
  REPORT_SPACING_MS,
  REPORT_VALID_MS,
  REVERIFY_AFTER_MS,
  SELECTION_VERSION,
  GHOST_MIN_COUNT,
  HOUR_MS,
  LEASE_STALE_MS,
  MAX_CONSECUTIVE_ITEM_ERRORS,
  OUTSIDE_APPROVAL_ERROR_AFTER_MS,
  STUCK_ITEM_ERROR_AFTER_MS,
  VERDICT_GATHER_LIMIT,
} from "../config/dataDeletion.js";
import {
  countPrefix,
  objectExists,
  pdfKeyFor,
  deleteKeyChecked,
  listObjectsPage,
} from "../lib/r2.js";
import { REPORTING_TIMEZONE } from "../config/stats.js";
import {
  ValidationError,
  ConflictError,
  NotFoundError,
} from "../utils/errors.js";
import {
  selectDue,
  selectReportLists,
  type DeletionCandidate,
  type ExtraReportLists,
} from "./dataDeletionSelect.service.js";
import {
  DeadlineStop,
  RunStop,
  acquireLease,
  bucketProof,
  bucketsAreDistinct,
  createRunContext,
  gatherPaymentVerdict,
  ghostRateExceeded,
  isUnreachable,
  processCandidate,
  probeBucket,
  processComicItem,
  releaseLease,
  renewLease,
  resumeItem,
  runCanary,
  stillOwnsLease,
  storageSignal,
  type DeletionDeps,
  type ProofKind,
  type RunContext,
} from "./dataDeletionEngine.service.js";
import {
  eventHitRazorpayIds,
  realRazorpayReader,
} from "./dataDeletionGuard.service.js";

// The deletion sweep and its admin API (feature 6, plan section 3). One entry in SCHEDULED SWEEPS (before the email
// sweeps): takes the lease, rotates the groups, and per mode gathers verdicts and writes a report (REPORT_ONLY) or
// deletes (ACTIVE). It throws only on a transition (a pause begins, an item turns FAILED, a run stops with an error).

export const defaultDeps: DeletionDeps = {
  now: () => new Date(),
  rzp: realRazorpayReader,
};

const GROUPS: DeletionGroup[] = ["PREVIEWS", "PHOTOS", "BOOKS"];
const GROUP_SCOPES: Record<DeletionGroup, DeletionScope[]> = {
  PREVIEWS: ["SESSION"],
  PHOTOS: ["PHOTO"],
  BOOKS: ["PAGES", "PDF", "ADDRESS", "COMIC"],
};
const GROUP_BUCKETS: Record<DeletionGroup, ("public" | "private")[]> = {
  PREVIEWS: ["private", "public"],
  PHOTOS: ["private"],
  BOOKS: ["public"],
};
const PROOF_KINDS: Record<DeletionGroup, ProofKind[]> = {
  PREVIEWS: ["private_photo", "public_pages"],
  PHOTOS: ["private_photo"],
  BOOKS: ["public_pages", "pdfs"],
};

const pairKey = (c: { scope: string; subjectId: string }) =>
  `${c.scope}:${c.subjectId}`;

interface RunSummary {
  attempted: number;
  transitions: string[];
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

async function writeReport(
  ctx: RunContext,
  group: DeletionGroup,
  mode: DeletionMode
): Promise<void> {
  const now = ctx.deps.now();
  const selection = await selectDue(group, now, {
    limit: REPORT_ID_CAP,
    blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
    onlyComicId: ctx.deps.onlyComicId,
  });
  // A preview with an unpaid order whose payment status has not been checked yet is listed apart and never approved.
  let notChecked: string[] = [];
  if (group === "PREVIEWS") {
    const clear = await freshClearVerdicts(selection.candidates, now);
    const unchecked = selection.candidates.filter(
      (c) => c.orderId && !clear.has(c.orderId)
    );
    notChecked = unchecked.map(pairKey);
    const skip = new Set(unchecked.map(pairKey));
    selection.candidates = selection.candidates.filter(
      (c) => !skip.has(pairKey(c))
    );
  }
  // The delivery-clock and kept-order lists are about delivered books: only the PHOTOS and BOOKS reports carry them.
  const extra: ExtraReportLists =
    group === "PREVIEWS"
      ? {
          failedClock: [],
          keptOrders: [],
          paidNotDelivered: [],
          openAddress: [],
          stuckSync: [],
          outOfPrefix: [],
        }
      : await selectReportLists(now);
  const objectCounts: Record<string, number> = {};
  const sample = selection.candidates.slice(0, REPORT_SAMPLE_SIZE);
  for (const c of sample) {
    // Sampling stops at the run deadline or on the first storage fault: the report then says it is partial.
    if (ctx.deps.now().getTime() >= ctx.deadlineAt) {
      objectCounts["partial"] = 1;
      break;
    }
    try {
      if (c.scope === "SESSION" || c.scope === "PAGES" || c.scope === "PHOTO") {
        const prefix =
          c.scope === "PHOTO"
            ? `sessions/${c.sessionId}/photo-`
            : `sessions/${c.sessionId}/`;
        const bucket = c.scope === "PHOTO" ? "private" : "public";
        objectCounts[`${c.scope}:${bucket}`] =
          (objectCounts[`${c.scope}:${bucket}`] ?? 0) +
          (await countPrefix(bucket, prefix, storageSignal()));
        if (c.scope === "SESSION") {
          objectCounts["SESSION:private"] =
            (objectCounts["SESSION:private"] ?? 0) +
            (await countPrefix("private", prefix, storageSignal()));
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, group },
        "[Data deletion] a report count failed"
      );
      objectCounts["error"] = (objectCounts["error"] ?? 0) + 1;
      if (isUnreachable(error)) {
        objectCounts["partial"] = 1;
        break;
      }
    }
  }
  const proof: Record<string, string> = {};
  if (!bucketsAreDistinct()) {
    proof["error"] = "buckets_equal";
  } else {
    try {
      for (const kind of PROOF_KINDS[group])
        proof[kind] = await bucketProof(ctx, kind);
    } catch (error) {
      logger.warn(
        { err: error, group },
        "[Data deletion] the bucket proof could not run"
      );
      proof["error"] = "storage_unreachable";
    }
  }
  const since = new Date(now.getTime() - DAY_MS);
  const ghosts = await prisma.deletionItem.count({
    where: {
      scope: { in: GROUP_SCOPES[group] },
      ghost: true,
      claimedAt: { gte: since },
    },
  });
  const run = await prisma.deletionRun.create({
    data: {
      group,
      mode,
      selectionVersion: SELECTION_VERSION[group],
      startedAt: now,
      finishedAt: ctx.deps.now(),
      dueCount: selection.candidates.length,
      ghostCount: ghosts,
      objectCounts: objectCounts as Prisma.InputJsonValue,
      proof: proof as Prisma.InputJsonValue,
      lists: {
        due: selection.candidates.map(pairKey),
        failedClock: [
          ...new Set([...selection.lists.failedClock, ...extra.failedClock]),
        ].slice(0, REPORT_ID_CAP),
        legacyPdf: selection.lists.legacyPdf.slice(0, REPORT_ID_CAP),
        keptOrders: extra.keptOrders,
        paidNotDelivered: extra.paidNotDelivered,
        openAddress: extra.openAddress,
        stuckSync: extra.stuckSync,
        outOfPrefix: extra.outOfPrefix,
        blocked: selection.lists.blocked.slice(0, REPORT_ID_CAP),
        notChecked: notChecked.slice(0, REPORT_ID_CAP),
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.deletionGroupSetting.update({
    where: { group },
    data: { lastReportAt: now },
  });
  // Full id lists only on the latest run per group and the approved run: older runs keep counts.
  const settings = await prisma.deletionGroupSetting.findUnique({
    where: { group },
  });
  const keep = [run.id, settings?.approvedRunId].filter(
    (v): v is string => !!v
  );
  await prisma.$executeRaw`UPDATE "deletion_runs" SET "lists" = NULL WHERE "group" = ${group}::"DeletionGroup" AND "lists" IS NOT NULL AND "id" <> ALL(${keep}::text[])`;
}

/** Every Razorpay order id (current and superseded) of the CREATED orders of these candidates. */
async function createdOrderRazorpayIds(
  candidates: DeletionCandidate[]
): Promise<string[]> {
  const orders = await prisma.order.findMany({
    where: {
      orderSessionId: { in: candidates.map((c) => c.subjectId) },
      status: "CREATED",
    },
    select: { razorpayOrderId: true, supersededRazorpayOrderIds: true },
  });
  return orders
    .flatMap((o) => [o.razorpayOrderId, ...o.supersededRazorpayOrderIds])
    .filter((v): v is string => !!v);
}

/** Gathers payment verdicts for due previews (REPORT_ONLY and the start of every tick). */
async function gatherVerdicts(ctx: RunContext, now: Date): Promise<void> {
  const selection = await selectDue("PREVIEWS", now, {
    limit: VERDICT_GATHER_LIMIT,
    blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
    onlyComicId: ctx.deps.onlyComicId,
  });
  ctx.eventHits = await eventHitRazorpayIds(
    await createdOrderRazorpayIds(selection.candidates)
  );
  // Ask about each order at most once a day: skip a clear verdict under 24 hours old, and ask the least recently
  // checked (or never checked) first, so every due preview gets its turn within the call budget.
  const verdicts = await freshClearVerdicts(selection.candidates, now);
  const checkedAt = await verdictTimes(selection.candidates);
  const waiting = selection.candidates
    .filter((c) => !c.orderId || !verdicts.has(c.orderId))
    .sort(
      (a, b) =>
        (checkedAt.get(a.orderId ?? "") ?? 0) -
        (checkedAt.get(b.orderId ?? "") ?? 0)
    );
  for (const candidate of waiting) {
    if (ctx.razorpayBudget.left <= 0) break;
    await gatherPaymentVerdict(ctx, candidate);
  }
}

/** Order ids of these candidates that have a "clear" verdict made in the last 24 hours. */
async function freshClearVerdicts(
  candidates: DeletionCandidate[],
  now: Date
): Promise<Set<string>> {
  const ids = candidates.map((c) => c.orderId).filter((v): v is string => !!v);
  if (ids.length === 0) return new Set();
  const rows = await prisma.deletionBlock.findMany({
    where: {
      subjectId: { in: ids },
      reason: "clear",
      checkedAt: { gt: new Date(now.getTime() - RAZORPAY_VERDICT_TTL_MS) },
    },
    select: { subjectId: true },
  });
  return new Set(rows.map((r) => r.subjectId));
}

/** When each of these orders last got a verdict (milliseconds; missing means never). */
async function verdictTimes(
  candidates: DeletionCandidate[]
): Promise<Map<string, number>> {
  const ids = candidates.map((c) => c.orderId).filter((v): v is string => !!v);
  const rows = ids.length
    ? await prisma.deletionBlock.findMany({
        where: { subjectId: { in: ids } },
        select: { subjectId: true, checkedAt: true },
      })
    : [];
  return new Map(rows.map((r) => [r.subjectId, r.checkedAt.getTime()]));
}

// ---------------------------------------------------------------------------------------------
// ACTIVE run of one group
// ---------------------------------------------------------------------------------------------

async function usedLast24h(group: DeletionGroup, now: Date): Promise<number> {
  return prisma.deletionItem.count({
    where: {
      scope: { in: GROUP_SCOPES[group].filter((s) => s !== "COMIC") },
      claimedAt: { gte: new Date(now.getTime() - DAY_MS) },
      state: { in: ["CLAIMED", "DONE"] },
    },
  });
}

async function pauseGroup(
  group: DeletionGroup,
  reason: string,
  now: Date,
  toReportOnly: boolean,
  summary: RunSummary
): Promise<void> {
  const current = await prisma.deletionGroupSetting.findUniqueOrThrow({
    where: { group },
  });
  const began = current.pausedReason !== reason;
  await prisma.deletionGroupSetting.update({
    where: { group },
    data: {
      pausedReason: reason,
      pausedAt: began ? now : current.pausedAt,
      ...(toReportOnly
        ? {
            mode: "REPORT_ONLY",
            modeChangedAt: now,
            // A fresh report is written on the next tick: a group needs one after every mode change.
            lastReportAt: null,
            approvedRunId: null,
            approvedSelectionVersion: null,
            approvedAt: null,
            approvalExhaustedAt: null,
          }
        : {}),
    },
  });
  if (began) summary.transitions.push(`${group} paused: ${reason}`);
  else
    logger.error(
      { group, reason },
      "[Data deletion] the group is still paused"
    );
}

/**
 * The (scope, id) pairs of the approved report, an empty set when no report was approved, and null when one was but its
 * run or its list is gone (the caller must not read that as "nothing approved").
 */
async function approvedPairs(settings: {
  approvedRunId: string | null;
}): Promise<Set<string> | null> {
  if (!settings.approvedRunId) return new Set();
  const run = await prisma.deletionRun.findUnique({
    where: { id: settings.approvedRunId },
    select: { lists: true },
  });
  const due = (run?.lists as { due?: string[] } | null)?.due;
  return due ? new Set(due) : null;
}

/** The oldest `dueAt` of these candidates, or null when there are none. */
function oldestDueAt(candidates: DeletionCandidate[]): Date | null {
  let oldest: Date | null = null;
  for (const c of candidates)
    if (!oldest || c.dueAt.getTime() < oldest.getTime()) oldest = c.dueAt;
  return oldest;
}

const ageHours = (from: Date, now: Date) =>
  Math.floor((now.getTime() - from.getTime()) / HOUR_MS);

/** Steady state: a due item more than 24 hours past due is a backlog above dailyMax (one error line per run). */
function logOldDue(
  group: DeletionGroup,
  candidates: DeletionCandidate[],
  now: Date
) {
  const oldest = oldestDueAt(candidates);
  if (oldest && now.getTime() - oldest.getTime() > BACKLOG_ERROR_AFTER_MS)
    logger.error(
      { group, oldestDueAgeHours: ageHours(oldest, now) },
      "[Data deletion] the oldest due item is more than 24 hours past due (a backlog above the daily maximum)"
    );
}

/** One error line per run while an item has been FAILED or CLAIMED for over 24 hours (count and oldest age, no throw). */
async function logStuckItems(now: Date): Promise<void> {
  const cut = new Date(now.getTime() - STUCK_ITEM_ERROR_AFTER_MS);
  const stuck = await prisma.deletionItem.findMany({
    where: {
      OR: [
        { state: "CLAIMED", claimedAt: { lte: cut } },
        { state: "FAILED", updatedAt: { lte: cut } },
      ],
    },
    select: { state: true, claimedAt: true, updatedAt: true },
    take: REPORT_ID_CAP,
  });
  if (stuck.length === 0) return;
  const oldest = Math.min(
    ...stuck.map((i) =>
      (i.state === "CLAIMED" ? i.claimedAt : i.updatedAt).getTime()
    )
  );
  logger.error(
    { count: stuck.length, oldestAgeHours: ageHours(new Date(oldest), now) },
    "[Data deletion] items have been CLAIMED or FAILED for over 24 hours"
  );
}

async function runActiveGroup(
  ctx: RunContext,
  group: DeletionGroup,
  owner: string,
  summary: RunSummary
): Promise<void> {
  const now = ctx.deps.now();
  let settings = await prisma.deletionGroupSetting.findUniqueOrThrow({
    where: { group },
  });
  // Gates
  if (settings.approvedSelectionVersion !== SELECTION_VERSION[group]) {
    await pauseGroup(group, "selection_version_changed", now, true, summary);
    return;
  }
  const setting = await prisma.deletionSetting.findUniqueOrThrow({
    where: { id: 1 },
  });
  if (
    !setting.canaryPassedAt ||
    now.getTime() - setting.canaryPassedAt.getTime() > CANARY_VALID_MS
  ) {
    await pauseGroup(group, "canary_stale", now, false, summary);
    return;
  }
  if (!bucketsAreDistinct()) {
    await pauseGroup(group, "buckets_equal", now, false, summary);
    return;
  }
  // A pause for repeated item errors ends only when an admin has dealt with the stuck items (retry, release or undo).
  if (settings.pausedReason === "repeated_errors") {
    const open = await prisma.deletionItem.count({
      where: {
        scope: { in: GROUP_SCOPES[group] },
        state: { in: ["CLAIMED", "FAILED"] },
      },
    });
    if (open > 0) {
      logger.error(
        { group, open },
        "[Data deletion] the group is still paused: items need an admin"
      );
      return;
    }
  }
  // A pause because storage could not be reached ends when a storage call works again.
  // The probe is a real call to every bucket this group uses: a revoked token on one bucket must not look fixed.
  if (settings.pausedReason === "storage_unreachable") {
    try {
      for (const bucket of GROUP_BUCKETS[group]) await probeBucket(bucket);
    } catch (error) {
      logger.error(
        { err: error, group },
        "[Data deletion] the group is still paused: storage is not reachable"
      );
      return;
    }
  }
  // A pause caused by a failed bucket proof ends only when the proof is checked again and holds (no throw while it lasts).
  if (settings.pausedReason?.startsWith("proof_failed:")) {
    const kind = settings.pausedReason.slice(
      "proof_failed:".length
    ) as ProofKind;
    let again: "ok" | "none" | "failed" = "failed";
    try {
      again = await bucketProof(ctx, kind);
    } catch (error) {
      logger.warn(
        { err: error, group },
        "[Data deletion] the bucket proof could not run"
      );
    }
    if (again === "failed") {
      logger.error(
        { group, reason: settings.pausedReason },
        "[Data deletion] the group is still paused"
      );
      return;
    }
  }
  if (settings.pausedReason) {
    await prisma.deletionGroupSetting.update({
      where: { group },
      data: { pausedReason: null, pausedAt: null },
    });
    settings = { ...settings, pausedReason: null, pausedAt: null };
  }
  const scopes = GROUP_SCOPES[group];
  const stillActive = async () =>
    (
      await prisma.deletionGroupSetting.findUnique({
        where: { group },
        select: { mode: true },
      })
    )?.mode === "ACTIVE" && (await stillOwnsLease(owner));

  try {
    // 1. Resume CLAIMED items (outside dailyMax and the approval).
    const claimed = await prisma.deletionItem.findMany({
      where: {
        scope: { in: scopes.filter((s) => s !== "COMIC") },
        state: "CLAIMED",
      },
      orderBy: { claimedAt: "asc" },
      take: 50,
    });
    let consecutiveErrors = 0;
    for (const item of claimed) {
      if (!(await stillActive())) return;
      const outcome = await resumeItem(ctx, item);
      if (outcome) summary.attempted += 1;
      consecutiveErrors =
        outcome?.kind === "failed" ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ITEM_ERRORS) {
        await pauseGroup(
          group,
          "repeated_errors",
          ctx.deps.now(),
          false,
          summary
        );
        return;
      }
    }
    // A retired comic's files (BOOKS only): asked for by an admin, so outside dailyMax and the approved set.
    if (group === "BOOKS") {
      const comics = await prisma.deletionItem.findMany({
        where: { scope: "COMIC", state: "CLAIMED" },
        orderBy: { claimedAt: "asc" },
        take: 5,
      });
      for (const item of comics) {
        if (!(await stillActive())) return;
        const outcome = await processComicItem(ctx, item);
        if (outcome) summary.attempted += 1;
      }
    }
    // 2. New items within dailyMax.
    const remaining =
      settings.dailyMax - (await usedLast24h(group, ctx.deps.now()));
    if (remaining <= 0) {
      // The daily maximum is used up: in steady state a due item over 24 hours past due is the backlog.
      if (settings.approvalExhaustedAt) {
        const waiting = await selectDue(group, ctx.deps.now(), {
          limit: 3,
          blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
          onlyComicId: ctx.deps.onlyComicId,
        });
        logOldDue(group, waiting.candidates, ctx.deps.now());
      }
      return;
    }
    // The first run after OFF to ACTIVE deletes only the approved report's items.
    let restrict: Set<string> | null = null;
    if (!settings.approvalExhaustedAt) {
      const approved = await approvedPairs(settings);
      const expired =
        settings.approvedAt &&
        ctx.deps.now().getTime() - settings.approvedAt.getTime() >=
          APPROVAL_WINDOW_MS;
      if (expired) {
        await prisma.deletionGroupSetting.update({
          where: { group },
          data: { approvalExhaustedAt: ctx.deps.now() },
        });
      } else if (!approved) {
        // The approved report or its list is gone: an empty set would read as "used up" and start steady state.
        await pauseGroup(
          group,
          "approved_report_missing",
          ctx.deps.now(),
          true,
          summary
        );
        return;
      } else {
        restrict = approved;
      }
    }
    const selection = await selectDue(group, ctx.deps.now(), {
      limit: restrict ? REPORT_ID_CAP : remaining,
      blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
      onlyComicId: ctx.deps.onlyComicId,
    });
    if (group === "PREVIEWS") {
      ctx.eventHits = await eventHitRazorpayIds(
        await createdOrderRazorpayIds(selection.candidates)
      );
    }
    let due: DeletionCandidate[] = selection.candidates;
    if (!restrict) logOldDue(group, selection.candidates, ctx.deps.now());
    if (restrict) {
      const approved = restrict;
      due = due.filter((c) => approved.has(pairKey(c)));
      // Due but outside the approved set for over 2 days: shown on the page and logged (count and oldest age).
      const outside = selection.candidates.filter(
        (c) =>
          !approved.has(pairKey(c)) &&
          ctx.deps.now().getTime() - c.dueAt.getTime() >
            OUTSIDE_APPROVAL_ERROR_AFTER_MS
      );
      const oldestOutside = oldestDueAt(outside);
      if (oldestOutside)
        logger.error(
          {
            group,
            count: outside.length,
            oldestDueAgeHours: ageHours(oldestOutside, ctx.deps.now()),
          },
          "[Data deletion] due items outside the approved report are over 2 days old"
        );
      const dueKeys = new Set(selection.candidates.map(pairKey));
      const openItems = await prisma.deletionItem.findMany({
        where: { scope: { in: scopes }, state: { in: ["DONE", "FAILED"] } },
        select: { subjectId: true, scope: true },
      });
      const settled = new Set(openItems.map(pairKey));
      const unfinished = [...approved].some(
        (k) => dueKeys.has(k) && !settled.has(k)
      );
      if (!unfinished && due.length === 0) {
        // The approved set is used up: the group goes on automatically from this tick (steady state).
        await prisma.deletionGroupSetting.update({
          where: { group },
          data: { approvalExhaustedAt: ctx.deps.now() },
        });
        due = (
          await selectDue(group, ctx.deps.now(), {
            limit: remaining,
            blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
            onlyComicId: ctx.deps.onlyComicId,
          })
        ).candidates;
      }
    }
    let left = remaining;
    let failedInARow = 0;
    for (const candidate of due) {
      if (left <= 0) break;
      if (!(await stillActive())) return;
      const outcome = await processCandidate(ctx, candidate);
      summary.attempted += 1;
      if (outcome.kind === "done" || outcome.kind === "failed") left -= 1;
      failedInARow = outcome.kind === "failed" ? failedInARow + 1 : 0;
      if (failedInARow >= MAX_CONSECUTIVE_ITEM_ERRORS) {
        await pauseGroup(
          group,
          "repeated_errors",
          ctx.deps.now(),
          false,
          summary
        );
        return;
      }
      if (outcome.kind === "done" && outcome.ghost) {
        const since = new Date(
          Math.max(
            ctx.deps.now().getTime() - DAY_MS,
            settings.modeChangedAt.getTime()
          )
        );
        if (await ghostRateExceeded(scopes, since)) {
          await pauseGroup(group, "ghost_rate", ctx.deps.now(), true, summary);
          return;
        }
      }
    }
  } catch (error) {
    if (error instanceof DeadlineStop) return;
    if (error instanceof RunStop) {
      // A stop is a pause: it throws once (when it begins) and then logs one line per run while it lasts.
      await pauseGroup(group, error.reason, ctx.deps.now(), false, summary);
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Re-verify and purge
// ---------------------------------------------------------------------------------------------

async function reverifyDoneItems(
  ctx: RunContext,
  owner: string,
  activeGroups: Set<DeletionGroup>
): Promise<void> {
  const now = ctx.deps.now();
  const scopes = (
    ["SESSION", "PHOTO", "PAGES", "PDF"] as DeletionScope[]
  ).filter((scope) =>
    [...activeGroups].some((g) => GROUP_SCOPES[g].includes(scope))
  );
  if (scopes.length === 0) return;
  const items = await prisma.deletionItem.findMany({
    where: {
      state: "DONE",
      reverifiedAt: null,
      scope: { in: scopes },
      doneAt: { lte: new Date(now.getTime() - REVERIFY_AFTER_MS) },
    },
    orderBy: { doneAt: "asc" },
    take: 20,
  });
  for (const item of items) {
    if (
      ctx.deps.now().getTime() >= ctx.deadlineAt ||
      !(await stillOwnsLease(owner))
    )
      return;
    try {
      const targets: { bucket: "public" | "private"; prefix: string }[] = [];
      if (item.scope === "SESSION") {
        targets.push(
          { bucket: "private", prefix: `sessions/${item.subjectId}/` },
          { bucket: "public", prefix: `sessions/${item.subjectId}/` }
        );
      } else if (item.scope === "PHOTO") {
        targets.push({
          bucket: "private",
          prefix: `sessions/${item.subjectId}/photo-`,
        });
      } else if (item.scope === "PAGES") {
        targets.push({
          bucket: "public",
          prefix: `sessions/${item.subjectId}/`,
        });
      }
      let leftover = 0;
      for (const t of targets) {
        let token: string | undefined;
        do {
          const page = await listObjectsPage(
            t.bucket,
            t.prefix,
            token,
            storageSignal()
          );
          for (const key of page.keys) {
            await deleteKeyChecked(t.bucket, key, storageSignal());
            leftover += 1;
          }
          token = page.next;
        } while (token);
      }
      if (item.scope === "PDF") {
        const order = await prisma.order.findUnique({
          where: { id: item.subjectId },
          select: { orderSessionId: true },
        });
        if (
          order &&
          (await objectExists(
            "public",
            pdfKeyFor(order.orderSessionId),
            storageSignal()
          ))
        ) {
          await deleteKeyChecked(
            "public",
            pdfKeyFor(order.orderSessionId),
            storageSignal()
          );
          leftover += 1;
        }
      }
      if (leftover > 0)
        logger.error(
          { scope: item.scope, subjectId: item.subjectId, leftover },
          "[Data deletion] a late writer left files; they were deleted"
        );
      await prisma.deletionItem.update({
        where: { id: item.id },
        data: { reverifiedAt: ctx.deps.now() },
      });
    } catch (error) {
      logger.warn(
        { err: error, subjectId: item.subjectId },
        "[Data deletion] re-verify failed; it is tried again later"
      );
      return;
    }
  }
}

let lastPurgeAt = 0;
/** Groups whose report is failing right now (in this process): the sweep throws once per start of a failure. */
const reportFailing = new Set<DeletionGroup>();
/** Purges our own old rows (at most once an hour; `force` is for tests). */
export async function purgeOldRows(now: Date, force = false): Promise<void> {
  if (!force && now.getTime() - lastPurgeAt < HOUR_MS) return;
  lastPurgeAt = now.getTime();
  const runCut = new Date(now.getTime() - DELETION_RUN_RETENTION_DAYS * DAY_MS);
  const itemCut = new Date(
    now.getTime() - DELETION_ITEM_RETENTION_DAYS * DAY_MS
  );
  const settings = await prisma.deletionGroupSetting.findMany({
    select: { group: true, approvedRunId: true },
  });
  const keep: string[] = settings
    .map((s) => s.approvedRunId)
    .filter((v): v is string => !!v);
  for (const group of GROUPS) {
    const latest = await prisma.deletionRun.findFirst({
      where: { group },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (latest) keep.push(latest.id);
  }
  await prisma.deletionRun.deleteMany({
    where: { startedAt: { lt: runCut }, id: { notIn: keep } },
  });
  // DONE items are purged once re-verified long ago; ADDRESS and COMIC items are never re-verified, so by their done time.
  await prisma.deletionItem.deleteMany({
    where: {
      state: "DONE",
      OR: [
        { reverifiedAt: { lt: itemCut } },
        { scope: { in: ["ADDRESS", "COMIC"] }, doneAt: { lt: itemCut } },
      ],
    },
  });
  await prisma.deletionBlock.deleteMany({
    where: {
      checkedAt: { lt: new Date(now.getTime() - RAZORPAY_VERDICT_TTL_MS) },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

/**
 * The scheduled sweep. Returns how many items it attempted. Throws (once per transition) when a group paused, an
 * item turned FAILED or a run stopped with an error, so the sweep endpoint shows it.
 */
export async function sweepDataDeletion(
  deps: DeletionDeps = defaultDeps
): Promise<number> {
  // With every group OFF the sweep does nothing and writes nothing (not even the lease).
  const groups = await prisma.deletionGroupSetting.findMany();
  if (groups.every((g) => g.mode === "OFF")) return 0;
  const owner = await acquireLease(deps);
  if (!owner) return 0;
  const summary: RunSummary = { attempted: 0, transitions: [] };
  try {
    const start = deps.now();
    const byGroup = new Map(groups.map((g) => [g.group, g]));
    // The groups take turns first, and each gets a third of the budget, so one backlog cannot starve the others.
    const offset = Math.floor(start.getTime() / LEASE_STALE_MS) % GROUPS.length;
    const order = GROUPS.map(
      (_, i) => GROUPS[(i + offset) % GROUPS.length] as DeletionGroup
    );
    const share = DELETION_RUN_BUDGET_MS / GROUPS.length;

    // The daily canary (only after the owner's first manual canary passed).
    const setting = await prisma.deletionSetting.findUniqueOrThrow({
      where: { id: 1 },
    });
    const anyOn = groups.some((g) => g.mode !== "OFF");
    if (setting.canaryAutoEnabled && anyOn) {
      const lastPass = setting.canaryPassedAt?.getTime() ?? 0;
      if (start.getTime() - lastPass >= CANARY_AUTO_INTERVAL_MS) {
        await runCanary(deps, false);
      }
    }

    for (const group of order) {
      const settings = byGroup.get(group);
      if (!settings || settings.mode === "OFF") continue;
      const groupStart = deps.now().getTime();
      const ctx = createRunContext(
        deps,
        Math.min(groupStart + share, start.getTime() + DELETION_RUN_BUDGET_MS),
        RAZORPAY_CALLS_PER_RUN
      );
      if (settings.mode === "REPORT_ONLY") {
        try {
          if (group === "PREVIEWS") await gatherVerdicts(ctx, deps.now());
          const reportDue =
            !settings.lastReportAt ||
            deps.now().getTime() - settings.lastReportAt.getTime() >=
              REPORT_SPACING_MS;
          if (reportDue) await writeReport(ctx, group, "REPORT_ONLY");
          reportFailing.delete(group);
        } catch (error) {
          if (!(error instanceof DeadlineStop || error instanceof RunStop)) {
            logger.error(
              { err: error, group },
              "[Data deletion] the report failed"
            );
            // The sweep fails (and the scheduler sees it) when a report STARTS failing, not on every tick of a
            // fault that lasts: the error line above is logged each time, the report is retried each time.
            if (!reportFailing.has(group)) {
              reportFailing.add(group);
              summary.transitions.push(`${group} report failed`);
            }
          }
        }
        continue;
      }
      await runActiveGroup(ctx, group, owner, summary);
      await prisma.deletionGroupSetting.update({
        where: { group },
        data: { lastRunAt: deps.now() },
      });
      summary.transitions.push(...ctx.transitions);
      if (
        ctx.counters.claimed > 0 ||
        ctx.counters.failed > 0 ||
        ctx.transitions.length > 0
      ) {
        await prisma.deletionRun.create({
          data: {
            group,
            mode: "ACTIVE",
            selectionVersion: SELECTION_VERSION[group],
            startedAt: new Date(groupStart),
            finishedAt: deps.now(),
            claimedCount: ctx.counters.claimed,
            deletedCount: ctx.counters.deleted,
            ghostCount: ctx.counters.ghosts,
            errorCount: ctx.counters.failed,
          },
        });
      }
    }
    await logStuckItems(deps.now());
    // Leftovers and housekeeping with what is left of the budget.
    const tail = createRunContext(
      deps,
      start.getTime() + DELETION_RUN_BUDGET_MS,
      0
    );
    if (deps.now().getTime() < tail.deadlineAt) {
      const active = new Set(
        groups.filter((g) => g.mode === "ACTIVE").map((g) => g.group)
      );
      await reverifyDoneItems(tail, owner, active);
    }
    await purgeOldRows(deps.now());
  } finally {
    await releaseLease(owner);
  }
  if (summary.transitions.length > 0) {
    throw new Error(`Data deletion: ${summary.transitions.join("; ")}`);
  }
  return summary.attempted;
}

// ---------------------------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------------------------

export interface GroupModeInput {
  mode: DeletionMode;
  dailyMax?: number;
  /** Compare-and-set: the `modeChangedAt` the admin's page showed. */
  expectedModeChangedAt?: string;
  /** For ACTIVE: the report the admin read, its due count and the typed confirmation. */
  reportRunId?: string;
  dueCount?: number;
  confirmation?: string;
}

/** Switches a group's mode. ACTIVE needs a fresh approved report, a passed proof and canary, and the typed confirmation. */
export async function setGroupMode(
  group: DeletionGroup,
  input: GroupModeInput,
  adminEmail: string,
  deps: DeletionDeps = defaultDeps
) {
  const now = deps.now();
  const current = await prisma.deletionGroupSetting.findUnique({
    where: { group },
  });
  if (!current) throw new NotFoundError("Deletion group not found");
  if (
    input.expectedModeChangedAt &&
    new Date(input.expectedModeChangedAt).getTime() !==
      current.modeChangedAt.getTime()
  ) {
    throw new ConflictError(
      "This group was changed by someone else. Reload the page and try again."
    );
  }
  if (
    input.dailyMax !== undefined &&
    (!Number.isInteger(input.dailyMax) ||
      input.dailyMax < 1 ||
      input.dailyMax > DAILY_MAX_LIMIT)
  ) {
    throw new ValidationError(
      `Daily maximum must be a whole number from 1 to ${DAILY_MAX_LIMIT}`
    );
  }
  const data: Prisma.DeletionGroupSettingUpdateInput = {
    ...(input.dailyMax !== undefined ? { dailyMax: input.dailyMax } : {}),
  };
  if (input.mode === current.mode) {
    if (input.dailyMax === undefined)
      throw new ValidationError("The group is already in that mode");
    return prisma.deletionGroupSetting.update({ where: { group }, data });
  }
  if (input.mode !== "ACTIVE") {
    return prisma.deletionGroupSetting.update({
      where: { group },
      data: {
        ...data,
        mode: input.mode,
        modeChangedAt: now,
        modeChangedByEmail: adminEmail,
        // A fresh report is written on the next tick: a group needs one after every mode change.
        lastReportAt: null,
        approvedRunId: null,
        approvedSelectionVersion: null,
        approvedAt: null,
        approvalExhaustedAt: null,
        pausedReason: null,
        pausedAt: null,
      },
    });
  }
  // ACTIVE: under the run lease, so no report is written and no run starts between the checks and the switch.
  const owner = await acquireLease(deps);
  if (!owner)
    throw new ConflictError(
      "A deletion run is in progress. Try again in a minute."
    );
  try {
    return await activateGroup(group, input, current, data, adminEmail, now);
  } finally {
    await releaseLease(owner);
  }
}

/** The checks and the switch of one group to ACTIVE. Runs under the run lease. */
async function activateGroup(
  group: DeletionGroup,
  input: GroupModeInput,
  current: { mode: DeletionMode; modeChangedAt: Date },
  data: Prisma.DeletionGroupSettingUpdateInput,
  adminEmail: string,
  now: Date
) {
  if (!input.reportRunId)
    throw new ValidationError(
      "Read the latest report and confirm it to switch deletion on"
    );
  const report = await prisma.deletionRun.findFirst({
    where: { group, mode: "REPORT_ONLY" },
    orderBy: { startedAt: "desc" },
  });
  if (!report || report.id !== input.reportRunId) {
    throw new ConflictError(
      "A newer report exists. Reload the page, read it, and confirm again."
    );
  }
  // The approved id list lives in the report: a report whose list was emptied cannot approve anything.
  if (!report.lists) {
    throw new ConflictError(
      "The lists of this report are no longer stored. Wait for a new report."
    );
  }
  if (now.getTime() - report.startedAt.getTime() > REPORT_VALID_MS) {
    throw new ConflictError(
      "The report is older than 7 days. Wait for a new one."
    );
  }
  // The report must have been made after the group's last mode change (a pause or a switch needs a fresh one).
  if (report.startedAt.getTime() < current.modeChangedAt.getTime()) {
    throw new ConflictError(
      "This group changed mode after that report was made. Wait for a new report."
    );
  }
  if (report.selectionVersion !== SELECTION_VERSION[group]) {
    throw new ConflictError(
      "The rules for this group changed after the report. Wait for a new one."
    );
  }
  if (report.dueCount < 1) {
    throw new ValidationError(
      "The report lists nothing to delete, so there is nothing to approve yet"
    );
  }
  const proof = (report.proof ?? {}) as Record<string, string>;
  if (Object.values(proof).includes("failed") || proof["error"]) {
    throw new ConflictError(
      "The storage check in this report failed. Fix it and wait for a new report."
    );
  }
  if (
    input.dueCount !== report.dueCount ||
    input.confirmation !== `DELETE ${report.dueCount}`
  ) {
    throw new ValidationError(`Type DELETE ${report.dueCount} to confirm`);
  }
  const setting = await prisma.deletionSetting.findUniqueOrThrow({
    where: { id: 1 },
  });
  if (
    !setting.canaryPassedAt ||
    now.getTime() - setting.canaryPassedAt.getTime() > CANARY_VALID_MS
  ) {
    throw new ConflictError(
      "Run the storage canary first (it must have passed in the last 36 hours)"
    );
  }
  // Compare-and-set on what this function read: a pause or a switch made by someone else meanwhile makes it fail.
  const switched = await prisma.deletionGroupSetting.updateMany({
    where: { group, mode: current.mode, modeChangedAt: current.modeChangedAt },
    data: {
      ...data,
      mode: "ACTIVE",
      modeChangedAt: now,
      modeChangedByEmail: adminEmail,
      approvedRunId: report.id,
      approvedSelectionVersion: report.selectionVersion,
      approvedAt: now,
      approvalExhaustedAt: null,
      pausedReason: null,
      pausedAt: null,
    },
  });
  if (switched.count !== 1) {
    throw new ConflictError(
      "This group was changed by someone else. Reload the page and try again."
    );
  }
  return prisma.deletionGroupSetting.findUniqueOrThrow({ where: { group } });
}

/** The Master's canary button: runs the same check at once. The first pass enables the daily canary. */
export async function runCanaryNow(deps: DeletionDeps = defaultDeps) {
  const result = await runCanary(deps, true);
  if (result.passed) {
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { canaryAutoEnabled: true },
    });
  }
  return result;
}

/** Back to CLAIMED for a FAILED item (or every FAILED item of a group). */
export async function retryItems(target: {
  itemId?: string;
  group?: DeletionGroup;
}): Promise<number> {
  if (!target.itemId && !target.group)
    throw new ValidationError("Give an item or a group");
  const result = await prisma.deletionItem.updateMany({
    where: {
      state: "FAILED",
      ...(target.itemId ? { id: target.itemId } : {}),
      ...(target.group ? { scope: { in: GROUP_SCOPES[target.group] } } : {}),
    },
    data: { state: "CLAIMED", attempts: 0, lastErrorAt: null, lastError: null },
  });
  return result.count;
}

const IS_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why an item cannot be released or undone now, or null when it can. Runs under the run lease (no run is working). */
async function clearBlocker(
  id: string,
  deps: DeletionDeps,
  mode: "release" | "undo"
): Promise<string | null> {
  const item = await prisma.deletionItem.findUnique({ where: { id } });
  if (!item) return "not_found";
  if (item.scope === "COMIC" || item.scope === "ADDRESS")
    return "not_offered_for_scope";
  if (
    mode === "undo"
      ? !(item.state === "DONE" && item.ghost)
      : item.state === "DONE"
  )
    return "wrong_state";
  const now = deps.now();
  if (now.getTime() - item.updatedAt.getTime() < LEASE_STALE_MS)
    return "changed_recently";
  // Nothing may have been deleted: the current counts equal the counts before the claim.
  const pre = (item.preCount ?? {}) as { private?: number; public?: number };
  const prefix =
    item.scope === "PHOTO"
      ? `sessions/${item.subjectId}/photo-`
      : `sessions/${item.subjectId}/`;
  if (item.scope === "PDF") {
    const order = await prisma.order.findUnique({
      where: { id: item.subjectId },
      select: { orderSessionId: true },
    });
    if (!order) return "not_found";
    const exists = await objectExists(
      "public",
      pdfKeyFor(order.orderSessionId),
      storageSignal()
    );
    return (exists ? 1 : 0) === (pre.public ?? 0) ? null : "files_changed";
  }
  const session = await prisma.orderSession.findUnique({
    where: { id: item.subjectId },
    select: { order: { select: { paidAfterDeletionAt: true } } },
  });
  if (!session) return "not_found";
  if (session.order?.paidAfterDeletionAt) return "paid_after_deletion";
  const buckets: ("private" | "public")[] =
    item.scope === "SESSION"
      ? ["private", "public"]
      : item.scope === "PHOTO"
        ? ["private"]
        : ["public"];
  for (const bucket of buckets) {
    if (
      (await countPrefix(bucket, prefix, storageSignal())) !==
      (pre[bucket] ?? 0)
    )
      return "files_changed";
  }
  return null;
}

/**
 * Clears the marker and the item of each given item that can be cleared, holding the run lease so no run works on
 * them at the same time. Returns the ones cleared and, for the others, why not.
 */
async function clearItems(
  ids: string[],
  deps: DeletionDeps,
  mode: "release" | "undo"
): Promise<{ cleared: string[]; refused: { id: string; reason: string }[] }> {
  const owner = await acquireLease(deps);
  if (!owner)
    throw new ConflictError(
      "A deletion run is in progress. Try again in a minute."
    );
  const cleared: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  try {
    for (const id of ids) {
      // Each item counts objects in storage: keep the lease fresh so a long request never lets it go stale.
      if (!(await renewLease(owner, deps))) {
        refused.push({ id, reason: "lease_lost" });
        continue;
      }
      const reason = await clearBlocker(id, deps, mode);
      if (reason) {
        refused.push({ id, reason });
        continue;
      }
      await clearMarkerAndItem(id);
      cleared.push(id);
    }
  } finally {
    await releaseLease(owner);
  }
  return { cleared, refused };
}

/** Clears the marker and the item of one CLAIMED or FAILED item whose files are untouched. */
export async function releaseItem(
  id: string,
  deps: DeletionDeps = defaultDeps
): Promise<void> {
  if (!IS_UUID.test(id)) throw new ValidationError("That is not an item id");
  const { refused } = await clearItems([id], deps, "release");
  if (refused[0])
    throw new ConflictError(`Cannot release this item: ${refused[0].reason}`);
}

/** Undoes a ghost verdict (DONE with `ghost`) whose files are still absent, so the item can be re-selected. */
export async function undoGhost(
  id: string,
  deps: DeletionDeps = defaultDeps
): Promise<void> {
  if (!IS_UUID.test(id)) throw new ValidationError("That is not an item id");
  const { refused } = await clearItems([id], deps, "undo");
  if (refused[0])
    throw new ConflictError(`Cannot undo this item: ${refused[0].reason}`);
}

const UNDO_RANGE_LIMIT = 500;

/** Undoes the ghosts of one item, or of every ghost claimed between two times (at most 500 at a time). */
export async function undoGhosts(
  target: { itemId?: string; from?: string; to?: string },
  deps: DeletionDeps = defaultDeps
): Promise<{
  undone: number;
  /** The ids of the items that were undone (for the admin log line). */
  ids: string[];
  refused: { id: string; reason: string }[];
  truncated: boolean;
}> {
  let ids: string[];
  let truncated = false;
  if (target.itemId) {
    if (!IS_UUID.test(target.itemId))
      throw new ValidationError("That is not an item id");
    ids = [target.itemId];
  } else {
    const rows = await prisma.deletionItem.findMany({
      where: {
        ghost: true,
        state: "DONE",
        claimedAt: {
          gte: new Date(target.from as string),
          lte: new Date(target.to as string),
        },
      },
      select: { id: true },
      take: UNDO_RANGE_LIMIT + 1,
    });
    truncated = rows.length > UNDO_RANGE_LIMIT;
    ids = rows.slice(0, UNDO_RANGE_LIMIT).map((row) => row.id);
  }
  const { cleared, refused } = await clearItems(ids, deps, "undo");
  return { undone: cleared.length, ids: cleared, refused, truncated };
}

async function clearMarkerAndItem(id: string): Promise<void> {
  const item = await prisma.deletionItem.findUniqueOrThrow({ where: { id } });
  await prisma.$transaction(async (tx) => {
    // The same locks as the claim and the payment webhook (order first, then session), and a payment that was
    // recorded after deletion in the meantime still stops the release.
    if (item.scope === "PDF") {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${item.subjectId} FOR UPDATE`;
    } else {
      const orders = await tx.$queryRaw<
        { paidAfterDeletionAt: Date | null }[]
      >`SELECT "paidAfterDeletionAt" FROM "orders" WHERE "orderSessionId" = ${item.subjectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "order_sessions" WHERE "id" = ${item.subjectId} FOR UPDATE`;
      if (orders[0]?.paidAfterDeletionAt) {
        throw new ConflictError(
          "A payment arrived after deletion: this item cannot be released."
        );
      }
    }
    if (item.scope === "SESSION") {
      await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = NULL, "filesDeletedAt" = NULL WHERE "id" = ${item.subjectId}`;
    } else if (item.scope === "PHOTO") {
      await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = NULL WHERE "id" = ${item.subjectId}`;
    } else if (item.scope === "PAGES") {
      await tx.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = NULL WHERE "id" = ${item.subjectId}`;
    } else if (item.scope === "PDF") {
      await tx.$executeRaw`UPDATE "orders" SET "pdfDeletedAt" = NULL WHERE "id" = ${item.subjectId}`;
    }
    await tx.deletionItem.delete({ where: { id } });
  });
}

/** Everything the admin page shows. */
export async function getDeletionOverview(deps: DeletionDeps = defaultDeps) {
  const now = deps.now();
  const [groups, setting] = await Promise.all([
    prisma.deletionGroupSetting.findMany({ orderBy: { group: "asc" } }),
    prisma.deletionSetting.findUniqueOrThrow({ where: { id: 1 } }),
  ]);
  const result = [];
  for (const g of groups) {
    const report = await prisma.deletionRun.findFirst({
      where: { group: g.group, mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    const scopes = GROUP_SCOPES[g.group];
    const [claimed, failed, oldestClaimed, oldestFailed, ghosts] =
      await Promise.all([
        prisma.deletionItem.count({
          where: { scope: { in: scopes }, state: "CLAIMED" },
        }),
        prisma.deletionItem.count({
          where: { scope: { in: scopes }, state: "FAILED" },
        }),
        prisma.deletionItem.findFirst({
          where: { scope: { in: scopes }, state: "CLAIMED" },
          orderBy: { claimedAt: "asc" },
          select: { claimedAt: true },
        }),
        prisma.deletionItem.findFirst({
          where: { scope: { in: scopes }, state: "FAILED" },
          orderBy: { updatedAt: "asc" },
          select: { updatedAt: true },
        }),
        prisma.deletionItem.count({
          where: {
            scope: { in: scopes },
            ghost: true,
            claimedAt: { gte: new Date(now.getTime() - DAY_MS) },
          },
        }),
      ]);
    // The items that need a look: stuck, failed or ghosts of the last day (ids and states only, never personal data).
    const attention = await prisma.deletionItem.findMany({
      where: {
        scope: { in: scopes },
        OR: [
          { state: { in: ["CLAIMED", "FAILED"] } },
          { ghost: true, claimedAt: { gte: new Date(now.getTime() - DAY_MS) } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        scope: true,
        subjectId: true,
        state: true,
        ghost: true,
        attempts: true,
        lastError: true,
        claimedAt: true,
        updatedAt: true,
      },
    });
    let dueNotApproved: number | null = null;
    let oldestDue: Date | null = null;
    if (g.mode === "ACTIVE") {
      const selection = await selectDue(g.group, now, {
        limit: REPORT_ID_CAP,
        blockTtlMs: RAZORPAY_VERDICT_TTL_MS,
        onlyComicId: deps.onlyComicId,
      });
      oldestDue = oldestDueAt(selection.candidates);
      if (!g.approvalExhaustedAt) {
        const approved = (await approvedPairs(g)) ?? new Set<string>();
        dueNotApproved = selection.candidates.filter(
          (c) => !approved.has(pairKey(c))
        ).length;
      }
    }
    result.push({
      group: g.group,
      mode: g.mode,
      dailyMax: g.dailyMax,
      modeChangedAt: g.modeChangedAt,
      modeChangedByEmail: g.modeChangedByEmail,
      pausedReason: g.pausedReason,
      pausedAt: g.pausedAt,
      approvalExhaustedAt: g.approvalExhaustedAt,
      selectionVersion: SELECTION_VERSION[g.group],
      report: report
        ? {
            id: report.id,
            startedAt: report.startedAt,
            selectionVersion: report.selectionVersion,
            dueCount: report.dueCount,
            ghostCount: report.ghostCount,
            objectCounts: report.objectCounts,
            proof: report.proof,
            lists: report.lists,
          }
        : null,
      items: {
        claimed,
        failed,
        oldestClaimedAt: oldestClaimed?.claimedAt ?? null,
        oldestFailedAt: oldestFailed?.updatedAt ?? null,
        ghostsLast24h: ghosts,
        ghostPauseMin: GHOST_MIN_COUNT,
      },
      dueNotApproved,
      oldestDueAt: oldestDue,
      attention,
    });
  }
  return {
    groups: result,
    canary: {
      passedAt: setting.canaryPassedAt,
      attemptedAt: setting.canaryAttemptedAt,
      autoEnabled: setting.canaryAutoEnabled,
      validHours: CANARY_VALID_MS / (60 * 60 * 1000),
    },
    paidAfterDeletionOrders: await prisma.order.count({
      where: { paidAfterDeletionAt: { not: null } },
    }),
  };
}
