// ⚠️ The customer text about how long photos are kept (frontend components/comic/PhotoGuidelines.tsx,
// PHOTO_CONFIDENTIAL_TEXT, and app/personalize/[sessionId]/preview/page.tsx) repeats the periods below and
// SESSION_LIFETIME_DAYS in services/session.service.ts. Two repos, change all together.
//
// Automatic data deletion (feature 6). Everything here is a constant on purpose (see config/reminders.ts):
// a value that can be misconfigured in one environment gives behaviour that is wrong but never errors.
// Deleted files cannot be restored, so every period carries a margin and every step a cap.

import type { DeletionGroup } from "../generated/prisma/client.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Bump a group's number whenever its selection (which sessions or orders it picks) changes. An approved
 * report is only valid for the version it was made with, and every run compares the numbers: a mismatch
 * drops the group to REPORT_ONLY. tests/unit/deletionSelectionVersion.test.ts fails when a selection
 * changes without a bump.
 */
export const SELECTION_VERSION: Record<DeletionGroup, number> = {
  PREVIEWS: 1,
  PHOTOS: 1,
  BOOKS: 1,
};

/** Added to every period below, so a clock or timezone slip can only make deletion later. */
export const DELETION_MARGIN_MS = HOUR_MS;

/** R1: an unpaid preview is deleted this long after `expiresAt` (the 7 days it was promised). */
export const PREVIEW_DELETION_DELAY_MS = DELETION_MARGIN_MS;
/** R1: a `CREATED` order must have been untouched this long (a payment may be in progress or its webhook late). */
export const ORDER_SETTLE_MS = 2 * DAY_MS;
/** R1: whatever the order does, an unpaid preview is never kept longer than this after `expiresAt`. */
export const PREVIEW_MAX_EXTRA_MS = 3 * DAY_MS;
/** R1: a Razorpay payment that is still `created` this recently keeps blocking even past the cap. */
export const PAYMENT_IN_FLIGHT_MS = HOUR_MS;

/** R2: the photo of a delivered book. */
export const PHOTO_DELETION_DAYS = 3;
/** R3 and R4: the pages and the PDF of a delivered book (the client's "1.5 months", D-078). */
export const BOOK_DELETION_DAYS = 45;
/** `deliveredAt` may be this far ahead of now (Shiprocket's IST times are read as UTC and err late). */
export const DELIVERED_FUTURE_TOLERANCE_MS = 6 * HOUR_MS;
/** A comic that was unpublished can be deleted or retired after this many days. */
export const COMIC_DELETE_AFTER_DAYS = 30;

/** Caps and timing of the engine. */
export const DAILY_MAX_LIMIT = 500;
/** The whole deletion entry stops starting new work after this long (the sweep itself times out at 120 s). */
export const DELETION_RUN_BUDGET_MS = 30_000;
/** Every storage call is aborted after this long. */
export const STORAGE_CALL_TIMEOUT_MS = 15_000;
/** Every Razorpay read is aborted after this long. */
export const RAZORPAY_CALL_TIMEOUT_MS = 5_000;
/** Razorpay reads (every call counts) one run may make. */
export const RAZORPAY_CALLS_PER_RUN = 20;
/** A "clear" verdict may be used to claim only this long after it was made (D-096); an older one is asked again. */
export const CLEAR_VERDICT_MAX_AGE_MS = 10 * 60 * 1000;
/** Previews whose payment status is gathered on one tick. */
export const VERDICT_GATHER_LIMIT = 100;
/** A Razorpay payment (even a failed one) created this recently keeps an order from being deleted. */
export const PAYMENT_RECENT_WINDOW_MS = 2 * DAY_MS;
/** The sweep runs its own canary when the last one passed longer ago than this. */
export const CANARY_AUTO_INTERVAL_MS = 20 * HOUR_MS;
/** A Razorpay verdict (clear or blocked) is not asked for again for this long. */
export const RAZORPAY_VERDICT_TTL_MS = DAY_MS;
/** A run lease older than this is taken over. */
export const LEASE_STALE_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** After this many items in a row fail with an error in one run, the group pauses (a setup fault would otherwise mark item after item). */
export const MAX_CONSECUTIVE_ITEM_ERRORS = 3;
/** After an error an item waits this long before its next attempt. */
export const ATTEMPT_GAP_MS = 30 * 60 * 1000;
/** A DONE item is listed once more after this long and any leftover (a late writer) is deleted. */
export const REVERIFY_AFTER_MS = DAY_MS;

/** REPORT_ONLY writes its report row at most this often (verdicts are still gathered on every tick). */
export const REPORT_SPACING_MS = 6 * HOUR_MS;
/** An approved report must be this young when a group goes ACTIVE. */
export const REPORT_VALID_MS = 7 * DAY_MS;
/** The first run after OFF to ACTIVE deletes only the approved items, for at most this long. */
export const APPROVAL_WINDOW_MS = 14 * DAY_MS;
export const REPORT_ID_CAP = 2000;
/** Sessions or orders per rule whose objects the report counts in storage. */
export const REPORT_SAMPLE_SIZE = 25;

/** Canary: a put, list and delete in each bucket. */
export const CANARY_VALID_MS = 36 * HOUR_MS;
export const CANARY_MAX_ATTEMPTS_PER_DAY = 3;
export const CANARY_RETRY_GAP_MS = HOUR_MS;

/** Ghosts: more than this share of a group's items in the last 24 hours (and at least the minimum) pauses it. */
export const GHOST_RATE_LIMIT = 0.2;
export const GHOST_MIN_COUNT = 3;
/** Bucket proof: how many candidate keys are tried, and how old (and undeleted) a candidate session must be. */
export const PROOF_CANDIDATES = 5;
export const PROOF_MIN_AGE_MS = 6 * HOUR_MS;

/** Retention of our own rows. */
export const DELETION_RUN_RETENTION_DAYS = 90;
export const DELETION_ITEM_RETENTION_DAYS = 90;
