import {
  ACTIVE_LONG_MS,
  ADMIN_QUEUE_WAIT_GRACE_MS,
  ADMIN_STUCK_GRACE_MS,
  MAX_ERROR_TEXT_LENGTH,
  RESTART_COOLDOWN_MS,
} from "../config/pageRecovery.js";
import type {
  OrderSessionStatus,
  OrderStatus,
  PageVersionStatus,
} from "../generated/prisma/client.js";

// Pure rules for the admin's "restart stuck pages" tool. No database, no queue: the
// service gathers the facts and these functions decide.

/** What the queue says about a row's job. "unavailable": Redis did not answer. */
export type JobState =
  | "active"
  | "waiting"
  | "prioritized"
  | "delayed"
  | "waiting-children"
  | "completed"
  | "failed"
  | "missing"
  | "unavailable";

export type PageRow = {
  id: string;
  variantIndex: number;
  status: PageVersionStatus;
  updatedAt: Date;
  errorMessage: string | null;
};

export type PageState =
  | "READY" // a finished variant exists and nothing blocks the book
  | "BLOCKED" // a finished variant exists, but a newer retry is stuck and blocks printing
  | "WAITING" // its job waits in the queue
  | "IN_PROGRESS" // being made (or just written to)
  | "STUCK" // nothing is making it
  | "FAILED"
  | "NOT_STARTED"; // no row at all

export type PageClassification = {
  state: PageState;
  /** The row a restart resets (null when there is none, or the page needs a new row). */
  targetRowId: string | null;
  /** A restart would create variant 0 (the page has no row). */
  needsRow: boolean;
  /** Can be restarted (with `force` when `requiresForce`). */
  restartable: boolean;
  requiresForce: boolean;
  /** The job must be removed before a new one is added. */
  removeJob: boolean;
  cooldownEndsAt: Date | null;
  /** Written to the admin: the newest row's last error, cut and stripped. */
  lastError: string | null;
  lastUpdatedAt: Date | null;
  /** Finished page with a retry that is running (nothing to do). */
  retryRunning: boolean;
};

const isInFlight = (status: PageVersionStatus) =>
  status !== "SD_READY" && status !== "FAILED";

/** Error text for the admin and the log: links removed, whitespace collapsed, cut. */
export function cleanErrorText(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  return plain.length > MAX_ERROR_TEXT_LENGTH
    ? `${plain.slice(0, MAX_ERROR_TEXT_LENGTH)}…`
    : plain;
}

const newest = <T extends { variantIndex: number }>(rows: T[]): T =>
  rows.reduce((a, b) => (b.variantIndex > a.variantIndex ? b : a));

/**
 * Where one page stands, and whether it can be restarted.
 *
 * Rules:
 *  - a page with a finished variant is never reset; if a newer retry is stuck it is
 *    BLOCKED (the customer cannot print while any row is in flight) and that row is
 *    restartable;
 *  - the row restarted is the newest unfinished one, in place (no new variant);
 *  - live job: "active", "delayed", "waiting-children" are being made and are left
 *    alone (an active one untouched for 30 minutes needs "Restart anyway");
 *    "waiting" or "prioritized" is stuck only after 10 minutes;
 *  - no live job (missing, completed, failed): stuck after 2 minutes; a row that
 *    reached the image service (GENERATING_SD) or whose job `failed` is held back for
 *    10 minutes first, because RunPod may still be running it.
 */
export function classifyPage(
  input: {
    isPreviewPage: boolean;
    rows: PageRow[];
    jobStateOf: (rowId: string) => JobState;
  },
  now: Date
): PageClassification {
  const { rows } = input;
  const nowMs = now.getTime();

  const base: PageClassification = {
    state: "READY",
    targetRowId: null,
    needsRow: false,
    restartable: false,
    requiresForce: false,
    removeJob: false,
    cooldownEndsAt: null,
    lastError: null,
    lastUpdatedAt: null,
    retryRunning: false,
  };

  if (rows.length === 0) {
    // A free preview page nobody generated is not part of what the customer paid for.
    return {
      ...base,
      state: "NOT_STARTED",
      needsRow: true,
      restartable: !input.isPreviewPage,
    };
  }

  const latest = newest(rows);
  base.lastError = cleanErrorText(latest.errorMessage);
  base.lastUpdatedAt = latest.updatedAt;

  const finished = rows.some((r) => r.status === "SD_READY");
  const inFlight = rows.filter((r) => isInFlight(r.status));

  if (inFlight.length === 0) {
    if (finished) return base;
    const row = newest(rows); // every row is FAILED
    const ends = row.updatedAt.getTime() + RESTART_COOLDOWN_MS;
    const cooling = nowMs < ends;
    return {
      ...base,
      state: "FAILED",
      targetRowId: row.id,
      restartable: true,
      requiresForce: cooling,
      cooldownEndsAt: cooling ? new Date(ends) : null,
      lastError: cleanErrorText(row.errorMessage),
      lastUpdatedAt: row.updatedAt,
    };
  }

  const row = newest(inFlight);
  const age = nowMs - row.updatedAt.getTime();
  const job = input.jobStateOf(row.id);
  base.lastError = cleanErrorText(row.errorMessage) ?? base.lastError;
  base.lastUpdatedAt = row.updatedAt;

  // What a stuck-looking row looks like to the admin: BLOCKED when a finished variant
  // exists (the retry holds the book back), STUCK otherwise.
  const stuckState: PageState = finished ? "BLOCKED" : "STUCK";
  const alive = (state: PageState): PageClassification => ({
    ...base,
    state: finished ? "READY" : state,
    retryRunning: finished,
    targetRowId: row.id,
  });

  if (job === "unavailable") return alive("IN_PROGRESS"); // cannot prove it is stuck

  if (job === "active" || job === "delayed" || job === "waiting-children") {
    if (age >= ACTIVE_LONG_MS) {
      return {
        ...alive("IN_PROGRESS"),
        restartable: true,
        requiresForce: true,
        removeJob: true,
      };
    }
    return alive("IN_PROGRESS");
  }

  if (job === "waiting" || job === "prioritized") {
    if (age < ADMIN_QUEUE_WAIT_GRACE_MS) return alive("WAITING");
    return {
      ...base,
      state: stuckState,
      targetRowId: row.id,
      restartable: true,
      removeJob: true,
    };
  }

  // No live job: missing, completed or failed.
  if (age < ADMIN_STUCK_GRACE_MS) return alive("IN_PROGRESS");

  const mayStillRun = row.status === "GENERATING_SD" || job === "failed";
  const ends = row.updatedAt.getTime() + RESTART_COOLDOWN_MS;
  const cooling = mayStillRun && nowMs < ends;
  return {
    ...base,
    state: stuckState,
    targetRowId: row.id,
    restartable: true,
    requiresForce: cooling,
    cooldownEndsAt: cooling ? new Date(ends) : null,
  };
}

export type OrderRule = {
  canRegenerate: boolean;
  blockedReason: string | null;
  /**
   * plain: the session stays as it is.
   * restore: the session FAILED (or went back to the preview stage by mistake) after
   *   payment; a restart restores it to GENERATING_PAID, and so restarts every
   *   restartable page (the book is announced ready only when it is).
   * stalled: PAID for over 10 minutes with the webhook's work missing.
   */
  mode: "plain" | "restore" | "stalled" | null;
};

const PAID_SETTLE_MINUTES = 10;

/** Which (order, session) states allow a restart. HTTP 409 text for the rest. */
export function orderRule(
  order: { status: OrderStatus; pdfUrl: string | null; updatedAt: Date },
  sessionStatus: OrderSessionStatus,
  now: Date
): OrderRule {
  const no = (reason: string): OrderRule => ({
    canRegenerate: false,
    blockedReason: reason,
    mode: null,
  });
  const frozen = "This order was already sent to print: its pages are frozen.";

  if (order.pdfUrl) return no(frozen);

  switch (order.status) {
    case "CREATED":
      return no("This order has not been paid yet.");
    case "CANCELLED":
      return no("This order was cancelled.");
    case "CONFIRMED":
    case "SHIPROCKET_FAILED":
    case "READY_TO_SHIP":
    case "SHIPPED":
    case "DELIVERED":
      return no(frozen);
    case "GENERATED":
      return sessionStatus === "PAID_PAGES_READY"
        ? { canRegenerate: true, blockedReason: null, mode: "plain" }
        : inconsistent();
    case "PAID": {
      if (sessionStatus === "GENERATING_PAID") {
        return { canRegenerate: true, blockedReason: null, mode: "plain" };
      }
      if (
        sessionStatus === "FAILED" ||
        sessionStatus === "PREVIEW_READY" ||
        sessionStatus === "GENERATING_PREVIEW"
      ) {
        return { canRegenerate: true, blockedReason: null, mode: "restore" };
      }
      if (sessionStatus === "PAID") {
        const young =
          now.getTime() - order.updatedAt.getTime() <
          PAID_SETTLE_MINUTES * 60 * 1000;
        return young
          ? no("Payment is still being processed. Try again in a minute.")
          : { canRegenerate: true, blockedReason: null, mode: "stalled" };
      }
      return inconsistent();
    }
  }

  function inconsistent(): OrderRule {
    return no("This order's state is inconsistent and needs a developer.");
  }
  return inconsistent();
}
