import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { redisClient } from "../lib/redis.js";
import { sdGenerationQueue } from "../jobs/queues.js";
import { settleTerminalPageFailure } from "../jobs/workers/generationWorker.js";
import { addPageJobs, maybeMarkPaidReady } from "./session.service.js";
import {
  notifyBookReady,
  notifyPaymentReceived,
} from "./notification.service.js";
import { emitSessionPaidReady } from "../websocket/event.js";
import { AppError, ConflictError, NotFoundError } from "../utils/errors.js";
import {
  classifyPage,
  orderRule,
  type JobState,
  type OrderRule,
  type PageClassification,
  type PageRow,
} from "../utils/pageRecovery.js";
import {
  LONG_POLL_STEP_MS,
  MAX_WAIT_SECONDS,
  ORDER_POST_COOLDOWN_MS,
  QUEUE_WAIT_MS,
} from "../config/pageRecovery.js";
import type {
  OrderSessionStatus,
  OrderStatus,
  PageVersionStatus,
} from "../generated/prisma/client.js";

// The admin's "restart stuck pages" tool.
// It resets the newest unfinished PageVersion row of a page IN PLACE (no new variant, no
// use of the customer's regeneration slots) and queues it again. It writes only PageVersion
// rows and, in two places, OrderSession.status. It never writes an Order row itself and
// never touches payment, pricing or the bill, so a restart can never charge the customer.
// The one Order change, PAID to GENERATED when an order whose pages are all finished is
// completed, is made by the existing maybeMarkPaidReady, exactly as the worker does it.

const RESTORE_FROM: OrderSessionStatus[] = [
  "FAILED",
  "PREVIEW_READY",
  "GENERATING_PREVIEW",
];

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

class QueueTimeoutError extends Error {}

/** A refusal because some pages are in their cooldown: the admin may repeat it with "Restart anyway". Its own code, so the screen never has to read the message. */
class CoolingDownError extends AppError {
  constructor(message: string) {
    super(message, 409, "COOLING_DOWN");
  }
}

/** The queue could not be asked at all, before anything was written: the same request can be repeated at once. */
class QueueDownBeforeWriteError extends AppError {
  constructor() {
    super(
      "The queue is not reachable. Nothing was changed. Try again in a few minutes.",
      503,
      "QUEUE_UNAVAILABLE"
    );
  }
}

/**
 * Stops the REQUEST waiting; it cannot cancel the command. redisClient is created with
 * maxRetriesPerRequest: null, so a command sent while Redis is down waits and runs later.
 */
function withinLimit<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new QueueTimeoutError("Redis did not answer in time")),
      QUEUE_WAIT_MS
    );
  });
  return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
}

/** A command sent while the client is not ready would sit in its offline queue. */
const queueReady = () => redisClient.status === "ready";

const noLiveStates = new Set(["completed", "failed"]);
const liveStates = new Set([
  "active",
  "waiting",
  "prioritized",
  "delayed",
  "waiting-children",
]);

/** The BullMQ state of each row's job (job id = row id, see addPageJobs). */
async function jobStatesFor(rowIds: string[]): Promise<Map<string, JobState>> {
  const states = new Map<string, JobState>();
  if (rowIds.length === 0) return states;

  if (!queueReady()) {
    rowIds.forEach((id) => states.set(id, "unavailable"));
    return states;
  }

  await Promise.all(
    rowIds.map(async (id) => {
      try {
        const state = await withinLimit(
          (async () => {
            const job = await sdGenerationQueue.getJob(id);
            return job ? await job.getState() : "missing";
          })()
        );
        states.set(
          id,
          liveStates.has(state) || noLiveStates.has(state)
            ? (state as JobState)
            : "missing"
        );
      } catch (err) {
        logger.warn(
          { err, rowId: id },
          "[Page recovery] Could not read a job state"
        );
        states.set(id, "unavailable");
      }
    })
  );
  return states;
}

// ---------------------------------------------------------------------------
// Reading an order's pages
// ---------------------------------------------------------------------------

type Context = {
  order: {
    id: string;
    status: OrderStatus;
    pdfUrl: string | null;
    updatedAt: Date;
  };
  session: { id: string; status: OrderSessionStatus; filesDeleted: boolean };
  pages: { pageId: string; pageNumber: number; isPreviewPage: boolean }[];
};

async function loadContext(orderId: string): Promise<Context> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      pdfUrl: true,
      updatedAt: true,
      orderSession: {
        select: {
          id: true,
          status: true,
          // Automatic data deletion (feature 6): a session whose files were deleted cannot be regenerated.
          photoDeletedAt: true,
          filesDeletedAt: true,
          sessionPages: {
            select: {
              pageId: true,
              isPreviewPage: true,
              page: { select: { pageNumber: true } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new NotFoundError("Order not found");

  const { orderSession } = order;
  return {
    order: {
      id: order.id,
      status: order.status,
      pdfUrl: order.pdfUrl,
      updatedAt: order.updatedAt,
    },
    session: {
      id: orderSession.id,
      status: orderSession.status,
      filesDeleted: !!orderSession.photoDeletedAt || !!orderSession.filesDeletedAt,
    },
    pages: orderSession.sessionPages
      .map((sp) => ({
        pageId: sp.pageId,
        pageNumber: sp.page.pageNumber,
        isPreviewPage: sp.isPreviewPage,
      }))
      .sort((a, b) => a.pageNumber - b.pageNumber),
  };
}

type RowWithPage = PageRow & { pageId: string };

const loadRows = (sessionId: string): Promise<RowWithPage[]> =>
  prisma.pageVersion.findMany({
    where: { orderSessionId: sessionId },
    select: {
      id: true,
      pageId: true,
      variantIndex: true,
      status: true,
      updatedAt: true,
      errorMessage: true,
    },
  });

const inFlight = (status: PageVersionStatus) =>
  status !== "SD_READY" && status !== "FAILED";

type PageView = {
  pageNumber: number;
  pageId: string;
  isPreviewPage: boolean;
  rows: RowWithPage[];
  cls: PageClassification;
};

async function buildPages(
  ctx: Context,
  rows: RowWithPage[],
  now: Date
): Promise<{ pages: PageView[]; queueAvailable: boolean }> {
  const byPage = new Map<string, RowWithPage[]>();
  for (const row of rows) {
    const list = byPage.get(row.pageId) ?? [];
    list.push(row);
    byPage.set(row.pageId, list);
  }

  // Redis is asked only for the NEWEST in-flight row of each page.
  const newestInFlight = [...byPage.values()]
    .map((list) => list.filter((r) => inFlight(r.status)))
    .filter((list) => list.length > 0)
    .map(
      (list) =>
        list.reduce((a, b) => (b.variantIndex > a.variantIndex ? b : a)).id
    );
  const states = await jobStatesFor(newestInFlight);
  const queueAvailable =
    queueReady() &&
    (newestInFlight.length === 0 ||
      [...states.values()].some((s) => s !== "unavailable"));

  const pages = ctx.pages.map((p) => {
    const pageRows = byPage.get(p.pageId) ?? [];
    return {
      pageNumber: p.pageNumber,
      pageId: p.pageId,
      isPreviewPage: p.isPreviewPage,
      rows: pageRows,
      cls: classifyPage(
        {
          isPreviewPage: p.isPreviewPage,
          rows: pageRows,
          jobStateOf: (id) => states.get(id) ?? "missing",
        },
        now
      ),
    };
  });
  return { pages, queueAvailable };
}

/** Changes whenever a row, the session or the order moves; the long-poll waits on it. */
function signatureOf(ctx: Context, rows: RowWithPage[]): string {
  const hash = createHash("sha1");
  hash.update(`${ctx.order.status}|${ctx.session.status}`);
  rows
    .map((r) => `${r.id}:${r.status}:${r.updatedAt.getTime()}`)
    .sort()
    .forEach((line) => hash.update(line));
  return hash.digest("hex").slice(0, 16);
}

// Readiness (maybeMarkPaidReady) depends on the PAID pages only, so a free preview page
// that was never generated must not make an order unrepairable.
const everyPageFinished = (pages: PageView[]) => {
  const paid = pages.filter((p) => !p.isPreviewPage);
  return (
    paid.length > 0 &&
    paid.every((p) => p.rows.some((r) => r.status === "SD_READY")) &&
    !pages.some((p) => p.rows.some((r) => inFlight(r.status)))
  );
};

/** Every page is finished but the order never moved on (a late job finished while the session said FAILED). */
function needsRepairOf(ctx: Context, pages: PageView[]): boolean {
  return (
    ctx.order.status === "PAID" &&
    ctx.order.pdfUrl === null &&
    (ctx.session.status === "GENERATING_PAID" ||
      ctx.session.status === "PAID" ||
      RESTORE_FROM.includes(ctx.session.status)) &&
    everyPageFinished(pages)
  );
}

export type AdminPageState = {
  pageNumber: number;
  isPreviewPage: boolean;
  state: PageClassification["state"];
  restartable: boolean;
  requiresForce: boolean;
  cooldownEndsAt: string | null;
  lastError: string | null;
  lastUpdatedAt: string | null;
  retryRunning: boolean;
  /** The page has an image-service (RunPod) step, so a restart can spend credit. */
  usesImageService: boolean;
};

export async function getOrderPageStatus(
  orderId: string,
  opts: { wait?: number; sig?: string; isClosed?: () => boolean } = {}
) {
  let ctx = await loadContext(orderId);
  let rows = await loadRows(ctx.session.id);
  let signature = signatureOf(ctx, rows);

  // Long-poll: hold the request while something is in progress and nothing has
  // changed, so an open order page keeps the (request-billed) server awake and
  // learns of progress at once. Database only, no Redis.
  const wait = Math.min(Math.max(opts.wait ?? 0, 0), MAX_WAIT_SECONDS);
  if (
    wait > 0 &&
    opts.sig === signature &&
    rows.some((r) => inFlight(r.status))
  ) {
    const deadline = Date.now() + wait * 1000;
    while (
      Date.now() < deadline &&
      !opts.isClosed?.() &&
      rows.some((r) => inFlight(r.status))
    ) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(LONG_POLL_STEP_MS, Math.max(deadline - Date.now(), 0))
        )
      );
      ctx = await loadContext(orderId);
      rows = await loadRows(ctx.session.id);
      if (signatureOf(ctx, rows) !== opts.sig) break;
    }
    signature = signatureOf(ctx, rows);
  }

  const now = new Date();
  const rule = orderRule(ctx.order, ctx.session.status, now, ctx.session.filesDeleted);
  const { pages, queueAvailable } = await buildPages(ctx, rows, now);

  const hasFace = new Map(
    (
      await prisma.page.findMany({
        where: { id: { in: ctx.pages.map((p) => p.pageId) } },
        select: { id: true, hasFace: true },
      })
    ).map((p) => [p.id, p.hasFace])
  );

  const count = (...states: PageClassification["state"][]) =>
    pages.filter((p) => states.includes(p.cls.state)).length;

  return {
    orderId: ctx.order.id,
    sessionId: ctx.session.id,
    orderStatus: ctx.order.status,
    sessionStatus: ctx.session.status,
    canRegenerate: rule.canRegenerate,
    blockedReason: rule.blockedReason,
    queueAvailable,
    needsRepair: rule.canRegenerate && needsRepairOf(ctx, pages),
    signature,
    summary: {
      total: pages.length,
      ready: count("READY"),
      waiting: count("WAITING"),
      inProgress: count("IN_PROGRESS"),
      stuck: count("STUCK"),
      blocked: count("BLOCKED"),
      failed: count("FAILED"),
      notStarted: count("NOT_STARTED"),
    },
    pages: pages.map(
      (p): AdminPageState => ({
        pageNumber: p.pageNumber,
        isPreviewPage: p.isPreviewPage,
        state: p.cls.state,
        // Nothing is offered when the order rule refuses or the queue cannot be asked.
        restartable: rule.canRegenerate && queueAvailable && p.cls.restartable,
        requiresForce: p.cls.requiresForce,
        cooldownEndsAt: p.cls.cooldownEndsAt?.toISOString() ?? null,
        lastError: p.cls.lastError,
        lastUpdatedAt: p.cls.lastUpdatedAt?.toISOString() ?? null,
        retryRunning: p.cls.retryRunning,
        usesImageService: hasFace.get(p.pageId) ?? false,
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// Restarting
// ---------------------------------------------------------------------------

export type SkipReason =
  | "FINISHED"
  | "ALREADY_RUNNING"
  | "CHANGED"
  | "COOLING_DOWN"
  | "NOT_IN_BOOK";

export type RegenerateInput = {
  pageNumbers?: number[];
  force?: boolean;
  /** "Finish this order": only move the order on; never restart a page, even if the state changed meanwhile. */
  repairOnly?: boolean;
};

const sendPaymentReceived = (sessionId: string) =>
  notifyPaymentReceived(sessionId).catch((err) =>
    logger.error(
      { err, sessionId },
      "[Page recovery] notifyPaymentReceived failed (swallowed)"
    )
  );

export type RegenerateResult = {
  queued: { pageNumber: number; pageVersionId: string }[];
  skipped: {
    pageNumber: number;
    reason: SkipReason;
    message: string;
    cooldownEndsAt?: string;
  }[];
  notTouched: { finished: number; running: number };
  sessionRestored: boolean;
  expanded: boolean;
  repaired: boolean;
  message: string | null;
};

// One restart request per order per minute. In memory: the service runs as one instance
// (Cloud Run max 1), and a restart of the process forgetting it is harmless.
const lastPostAt = new Map<string, number>();

function claimOrderSlot(orderId: string): void {
  const now = Date.now();
  for (const [id, at] of lastPostAt) {
    if (now - at >= ORDER_POST_COOLDOWN_MS) lastPostAt.delete(id);
  }
  const last = lastPostAt.get(orderId);
  if (last !== undefined && now - last < ORDER_POST_COOLDOWN_MS) {
    throw new AppError(
      "A restart was just requested for this order. Wait a minute and look at the pages again.",
      429,
      "TOO_MANY_REQUESTS"
    );
  }
  lastPostAt.set(orderId, now);
}

/** Test hook: forget the per-order limit. */
export const _resetOrderSlots = () => lastPostAt.clear();

const clock = (d: Date) => d.toISOString().slice(11, 16) + " UTC";

type Target = {
  page: PageView;
  rowId: string | null; // existing row to reset
  newRowId: string | null; // variant 0 to create
  seenStatus: PageVersionStatus | null;
  seenUpdatedAt: Date | null;
  removeJob: boolean;
};

/**
 * Remove the job a restarted row had, so the new add goes through (BullMQ ignores an add
 * whose job id belongs to a live OR a finished job). false: the job is running and cannot
 * be removed, so it is left to finish.
 */
async function clearOldJob(
  rowId: string,
  removeLive: boolean
): Promise<boolean> {
  const job = await withinLimit(sdGenerationQueue.getJob(rowId));
  if (!job) return true;
  const state = await withinLimit(job.getState());
  if (liveStates.has(state) && !removeLive) return false;
  try {
    await withinLimit(job.remove());
    return true;
  } catch (err) {
    // BullMQ refuses to remove a job a worker holds: it is running, leave it to finish.
    // Any other failure is a real queue problem and must not be called "running".
    if (err instanceof Error && /locked by another worker/.test(err.message)) {
      return false;
    }
    throw err;
  }
}

async function repairOrder(ctx: Context): Promise<RegenerateResult> {
  const { count } = await prisma.orderSession.updateMany({
    where: { id: ctx.session.id, status: { in: [...RESTORE_FROM, "PAID"] } },
    data: { status: "GENERATING_PAID" },
  });
  // A (PAID, PAID) order never got the webhook's flip, so nobody sent "payment received".
  if (count > 0 && ctx.session.status === "PAID")
    sendPaymentReceived(ctx.session.id);
  const ready = await maybeMarkPaidReady(ctx.session.id);

  if (ready === "ready") {
    emitSessionPaidReady(ctx.session.id);
    notifyBookReady(ctx.session.id).catch((err) =>
      logger.error(
        { err, sessionId: ctx.session.id },
        "[Page recovery] notifyBookReady failed (swallowed)"
      )
    );
  }
  logger.info(
    {
      orderId: ctx.order.id,
      sessionId: ctx.session.id,
      result: ready,
      restored: count > 0,
    },
    "[Page recovery] Order repaired (every page was already finished)"
  );
  return {
    queued: [],
    skipped: [],
    notTouched: { finished: ctx.pages.length, running: 0 },
    sessionRestored: count > 0,
    expanded: false,
    repaired: ready === "ready",
    message:
      ready === "ready"
        ? "The order has moved on: the customer can now choose and print."
        : "All pages are ready, but the order could not be moved on. Look at the order page again.",
  };
}

export async function regenerateOrderPages(
  orderId: string,
  adminId: string,
  input: RegenerateInput
): Promise<RegenerateResult> {
  const ctx = await loadContext(orderId);
  const now = new Date();
  const rule: OrderRule = orderRule(ctx.order, ctx.session.status, now, ctx.session.filesDeleted);
  if (!rule.canRegenerate)
    throw new ConflictError(rule.blockedReason ?? "Not allowed");

  // Finishing an order whose pages are all done needs no queue: it must work while Redis is
  // down (a Redis outage is what leaves such orders stuck). Only an explicit "finish"
  // (repairOnly) repairs: a restart, whole book or named pages, never turns into the email.
  if (input.repairOnly) {
    const earlyRows = await loadRows(ctx.session.id);
    const unclassified = ctx.pages.map((p) => ({
      ...p,
      rows: earlyRows.filter((r) => r.pageId === p.pageId),
    })) as unknown as PageView[];
    if (needsRepairOf(ctx, unclassified)) return repairOrder(ctx);
  }

  if (!queueReady()) {
    throw new QueueDownBeforeWriteError();
  }

  claimOrderSlot(orderId);
  try {
    const result = await run(ctx, rule, adminId, input, now);
    // Nothing was restarted (all skipped, nothing to do): the admin may try again at once.
    if (result.queued.length === 0 && !result.repaired)
      lastPostAt.delete(orderId);
    return result;
  } catch (err) {
    // Refused or failed before anything was written: do not hold the next try back. An error
    // that is not one of ours (a database error: the transaction rolled back) is the same.
    if (
      err instanceof ConflictError ||
      err instanceof CoolingDownError ||
      err instanceof QueueDownBeforeWriteError ||
      !(err instanceof AppError)
    ) {
      lastPostAt.delete(orderId);
    }
    throw err;
  }
}

async function run(
  ctx: Context,
  rule: OrderRule,
  adminId: string,
  input: RegenerateInput,
  now: Date
): Promise<RegenerateResult> {
  const force = input.force === true;
  const rows = await loadRows(ctx.session.id);

  let view: { pages: PageView[]; queueAvailable: boolean };
  try {
    view = await buildPages(ctx, rows, now);
  } catch (err) {
    throw unavailable(err);
  }
  const { pages } = view;
  if (!view.queueAvailable) {
    throw new QueueDownBeforeWriteError();
  }

  if (input.repairOnly && needsRepairOf(ctx, pages)) {
    return repairOrder(ctx);
  }
  if (input.repairOnly) {
    return {
      queued: [],
      skipped: [],
      notTouched: { finished: 0, running: 0 },
      sessionRestored: false,
      expanded: false,
      repaired: false,
      message:
        "The order changed, so there is nothing to finish now. Look at the pages again.",
    };
  }

  const skipped: RegenerateResult["skipped"] = [];
  const restore = rule.mode === "restore";

  // Which pages: the named ones, or every restartable page. A session that has to be
  // restored restarts ALL its restartable pages: it is announced ready as soon as every
  // page has settled with one success, so restarting one page of an all-failed book
  // would tell the customer "ready" while the others are still failed.
  const named = input.pageNumbers ? [...new Set(input.pageNumbers)] : null;
  const byNumber = new Map(pages.map((p) => [p.pageNumber, p]));
  let candidates: PageView[];
  let expanded = false;

  if (named) {
    candidates = [];
    for (const number of named) {
      const page = byNumber.get(number);
      if (!page) {
        skipped.push({
          pageNumber: number,
          reason: "NOT_IN_BOOK",
          message: "This page is not part of the book.",
        });
      } else if (page.cls.restartable) {
        candidates.push(page);
      } else {
        skipped.push(skipReasonFor(page));
      }
    }
    if (restore || rule.mode === "stalled") {
      // Every paid page that can be restarted (a book is announced ready only when they
      // have all settled); a free preview page only if it was named.
      const all = pages.filter(
        (p) => p.cls.restartable && (!p.isPreviewPage || candidates.includes(p))
      );
      expanded = all.length > candidates.length;
      candidates = all;
    }
  } else {
    candidates = pages.filter((p) => p.cls.restartable);
  }

  // The cooldown: a row that may still be running at the image service is held back
  // unless the admin says "Restart anyway". In a session being restored it is all or nothing.
  const cooling = candidates.filter((p) => p.cls.requiresForce);
  if (cooling.length > 0 && !force) {
    if (restore) {
      const until = cooling
        .map((p) => p.cls.cooldownEndsAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      throw new CoolingDownError(
        until
          ? `Some pages were restarted or failed a few minutes ago. They can be restarted at ${clock(until)}, or use Restart anyway. Nothing was changed.`
          : "Some pages look like they are still running. Use Restart anyway to restart them. Nothing was changed."
      );
    }
    for (const page of cooling) {
      skipped.push({
        pageNumber: page.pageNumber,
        reason: page.cls.cooldownEndsAt ? "COOLING_DOWN" : "ALREADY_RUNNING",
        message: page.cls.cooldownEndsAt
          ? `Wait until ${clock(page.cls.cooldownEndsAt)}, or use Restart anyway.`
          : "It looks like it is still running. Use Restart anyway if it has been stuck for over 30 minutes.",
        ...(page.cls.cooldownEndsAt && {
          cooldownEndsAt: page.cls.cooldownEndsAt.toISOString(),
        }),
      });
    }
    candidates = candidates.filter((p) => !p.cls.requiresForce);
  }

  const notTouched = {
    finished: pages.filter(
      (p) => p.cls.state === "READY" && !p.cls.retryRunning
    ).length,
    running: pages.filter(
      (p) =>
        p.cls.state === "IN_PROGRESS" ||
        p.cls.state === "WAITING" ||
        p.cls.retryRunning
    ).length,
  };

  const empty = (message: string | null): RegenerateResult => ({
    queued: [],
    skipped,
    notTouched,
    sessionRestored: false,
    expanded: false,
    repaired: false,
    message,
  });
  if (
    candidates.length === 0 &&
    rule.mode === "stalled" &&
    pages.some(
      (p) =>
        p.cls.state === "IN_PROGRESS" ||
        p.cls.state === "WAITING" ||
        p.cls.retryRunning
    )
  ) {
    // Pages are really being made (their jobs were queued before the webhook crashed), only the
    // session never moved on, so the completion check would never fire. Move it on.
    const { count } = await prisma.orderSession.updateMany({
      where: { id: ctx.session.id, status: "PAID" },
      data: { status: "GENERATING_PAID" },
    });
    if (count > 0) sendPaymentReceived(ctx.session.id);
    return {
      ...empty("The order has moved on: its pages are already being made."),
      sessionRestored: count > 0,
    };
  }
  if (candidates.length === 0) return empty("Nothing needed restarting.");

  const targets: Target[] = candidates.map((page) => {
    if (page.cls.needsRow) {
      return {
        page,
        rowId: null,
        newRowId: randomUUID(),
        seenStatus: null,
        seenUpdatedAt: null,
        removeJob: false,
      };
    }
    const row = page.rows.find((r) => r.id === page.cls.targetRowId)!;
    return {
      page,
      rowId: row.id,
      newRowId: null,
      seenStatus: row.status,
      seenUpdatedAt: row.updatedAt,
      removeJob: page.cls.removeJob,
    };
  });

  // ---- Database: all guarded, no Redis inside ------------------------------------
  const reset: { target: Target; rowId: string }[] = [];
  let sessionRestored = false;

  await prisma.$transaction(
    async (tx) => {
      const changed: Target[] = [];

      const fresh = targets.filter((t) => t.newRowId);
      if (fresh.length > 0) {
        await tx.pageVersion.createMany({
          data: fresh.map((t) => ({
            id: t.newRowId!,
            orderSessionId: ctx.session.id,
            pageId: t.page.pageId,
            variantIndex: 0,
            status: "QUEUED" as const,
          })),
          skipDuplicates: true, // a row made meanwhile by the webhook or the customer: not an error
        });
        const made = await tx.pageVersion.findMany({
          where: { id: { in: fresh.map((t) => t.newRowId!) } },
          select: { id: true },
        });
        const madeIds = new Set(made.map((m) => m.id));
        for (const t of fresh) {
          if (madeIds.has(t.newRowId!))
            reset.push({ target: t, rowId: t.newRowId! });
          else changed.push(t);
        }
      }

      for (const t of targets.filter((x) => x.rowId)) {
        // The guard is the row exactly as it was classified: status AND updatedAt. A
        // worker write moves updatedAt, so a page that was picked up meanwhile is left alone,
        // and the cooldown seen at classification still holds.
        const { count } = await tx.pageVersion.updateMany({
          where: {
            id: t.rowId!,
            status: t.seenStatus!,
            updatedAt: t.seenUpdatedAt!,
          },
          data: { status: "QUEUED", textStampedUrl: null },
        });
        if (count === 1) reset.push({ target: t, rowId: t.rowId! });
        else changed.push(t);
      }

      if (restore && changed.length > 0) {
        // All or nothing: a half-restored book could be announced ready with pages still failed.
        throw new ConflictError(
          "Some pages changed while restarting, so nothing was restarted. Look at the pages again and try once more."
        );
      }
      for (const t of changed) {
        skipped.push({
          pageNumber: t.page.pageNumber,
          reason: "CHANGED",
          message:
            "It changed while restarting (it may have just been picked up). Look at the pages again.",
        });
      }

      if (restore && reset.length > 0) {
        const { count } = await tx.orderSession.updateMany({
          where: { id: ctx.session.id, status: { in: RESTORE_FROM } },
          data: { status: "GENERATING_PAID" },
        });
        sessionRestored = count > 0;
        if (count === 0) {
          const current = await tx.orderSession.findUniqueOrThrow({
            where: { id: ctx.session.id },
            select: { status: true },
          });
          if (
            current.status !== "GENERATING_PAID" &&
            current.status !== "PAID_PAGES_READY"
          ) {
            throw new ConflictError(
              "The order changed while restarting. Look at the order again."
            );
          }
        }
      }
    },
    // A long book is one update per page over a remote database: more than Prisma's 5 s default.
    { timeout: 20_000, maxWait: 10_000 }
  );

  if (reset.length === 0) return empty("Nothing was restarted.");

  // ---- Redis: clear old jobs, add new ones ------------------------------------------
  const log = {
    orderId: ctx.order.id,
    sessionId: ctx.session.id,
    adminId,
    forced: force,
    pages: reset.map(({ target, rowId }) => ({
      pageNumber: target.page.pageNumber,
      rowId,
      previousStatus: target.seenStatus,
      previousError: target.page.cls.lastError,
    })),
  };

  let toAdd: { pageVersionId: string; pageNumber: number }[] = [];
  let addStarted = false; // once the add has been sent, a time-out may still turn into a job
  try {
    for (const { target, rowId } of reset) {
      const free = target.newRowId
        ? true
        : await clearOldJob(rowId, target.removeJob);
      if (free) {
        toAdd.push({
          pageVersionId: rowId,
          pageNumber: target.page.pageNumber,
        });
      } else {
        skipped.push({
          pageNumber: target.page.pageNumber,
          reason: "ALREADY_RUNNING",
          message: "It is running right now, so it was left to finish.",
        });
      }
    }
    if (toAdd.length > 0) {
      addStarted = true;
      await withinLimit(addPageJobs(toAdd));
    }
  } catch (err) {
    // Only a time-out of the ADD itself can still become a job later. A time-out while
    // clearing old jobs means nothing was added: those rows would sit QUEUED with no job.
    if (err instanceof QueueTimeoutError && addStarted) {
      logger.error(
        { ...log, err },
        "[Page recovery] Queue timed out; no compensation"
      );
      throw new AppError(
        "The restart may still start in a few minutes; check the order page.",
        503,
        "QUEUE_UNAVAILABLE"
      );
    }
    // The command was rejected, so nothing of ours will run later: put the rows back to failed.
    logger.error(
      { ...log, err },
      "[Page recovery] Queue rejected the restart; putting the pages back"
    );
    // Only rows whose old job was cleared (or never existed) and so would have been added are
    // put back. A row left running, the row the queue failed on, and rows not reached yet are
    // not: their old job may still be live (a waiting job is), so failing them could announce
    // a book ready while a job still runs. They sit QUEUED and can be restarted after 2 minutes.
    for (const { pageVersionId: rowId } of toAdd) {
      await settleTerminalPageFailure(rowId, "Could not be queued", {
        source: "admin-regenerate",
        staleBefore: new Date(Date.now() + 1000),
      }).catch((e) =>
        logger.error(
          { err: e, rowId },
          "[Page recovery] Could not put a page back"
        )
      );
    }
    throw new AppError(
      toAdd.length === 0
        ? "The queue did not answer, so some pages may not have started. Look at the order page in a couple of minutes: pages that did not start can be restarted again."
        : toAdd.length === reset.length
          ? "The queue is not reachable. The pages were put back to failed; wait about 10 minutes or use Restart anyway."
          : `The queue is not reachable. ${toAdd.length} of ${reset.length} pages were put back to failed (wait about 10 minutes or use Restart anyway); the others may not have started. Look at the order page in a couple of minutes.`,
      503,
      "QUEUE_UNAVAILABLE"
    );
  }

  // A (PAID, PAID) order whose webhook work never finished: flip AFTER the jobs are in
  // Redis, as the webhook does, and send "payment received" only if the flip matched.
  if (rule.mode === "stalled") {
    const { count } = await prisma.orderSession.updateMany({
      where: { id: ctx.session.id, status: "PAID" },
      data: { status: "GENERATING_PAID" },
    });
    sessionRestored = count > 0;
    if (count > 0) sendPaymentReceived(ctx.session.id);
  }

  logger.info(
    {
      ...log,
      skipped: skipped.map((x) => ({
        pageNumber: x.pageNumber,
        reason: x.reason,
      })),
    },
    "[Page recovery] Pages restarted"
  );

  const queuedNumbers = toAdd.map((a) => a.pageNumber);
  return {
    queued: toAdd.map((a) => ({
      pageNumber: a.pageNumber,
      pageVersionId: a.pageVersionId,
    })),
    skipped,
    notTouched,
    sessionRestored,
    expanded,
    repaired: false,
    message:
      queuedNumbers.length > 0
        ? `Restarted ${queuedNumbers.length} page${queuedNumbers.length === 1 ? "" : "s"} (${queuedNumbers.join(", ")}). The customer is not charged.`
        : "Nothing was restarted.",
  };
}

function skipReasonFor(page: PageView): RegenerateResult["skipped"][number] {
  switch (page.cls.state) {
    case "READY":
      return {
        pageNumber: page.pageNumber,
        reason: page.cls.retryRunning ? "ALREADY_RUNNING" : "FINISHED",
        message: page.cls.retryRunning
          ? "A retry of this page is running."
          : "This page is finished and is never touched.",
      };
    case "NOT_STARTED":
      return {
        pageNumber: page.pageNumber,
        reason: "NOT_IN_BOOK",
        message:
          "A free preview page that was never generated is not restarted here.",
      };
    default:
      return {
        pageNumber: page.pageNumber,
        reason: "ALREADY_RUNNING",
        message: "It is being made right now.",
      };
  }
}

function unavailable(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new QueueDownBeforeWriteError();
}
