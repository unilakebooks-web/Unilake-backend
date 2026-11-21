// ⚠️ The admin screen repeats the kinds, the offset caps and the limits below: frontend
// components/admin/emails/emailConfig.ts. Two repos, change both.
//
// Reminder emails (feature 5). Three reminders to the customer, switched on and timed by an admin:
//   PREVIEW_UNFINISHED (A)  a free preview was made and nothing bought
//   BOOK_NOT_SENT      (B)  paid, the book is ready, Send to Print was not pressed
//   REVIEW_REQUEST     (C)  feedback request after delivery
// Everything here is a constant on purpose (see config/stats.ts for the same reasoning): a value that
// can be misconfigured in one environment gives behaviour that is wrong but never errors.

import type { ReminderKind } from "../generated/prisma/client.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * "Paid, the book is ready, Send to Print not pressed": the order and session statuses reminder B is about
 * and the admin orders filter "Awaiting customer" shows. One definition, so the filter and the reminder
 * cannot drift apart.
 */
export const AWAITING_CUSTOMER_PRINT = {
  orderStatus: "GENERATED",
  sessionStatus: "PAID_PAGES_READY",
} as const;

/** The sending window's hour bounds (India time): start 0 to 23, end 1 to 24, start before end. ⚠️ Repeated in the frontend emailConfig.ts. */
export const WINDOW_START_MAX_HOUR = 23;
export const WINDOW_END_MAX_HOUR = 24;

/** An admin sets at most this many send times per reminder. */
export const MAX_REMINDER_OFFSETS = 3;

/**
 * Largest send time an admin may set, in hours. A: previews expire after 7 days (SESSION_LIFETIME_DAYS in
 * session.service.ts), so the last reminder must come before that. B: counted from when the book became
 * ready; 30 days keeps it well inside the time paid books are kept. C: counted from delivery; 40 days stays
 * inside the 1.5 months (45 days) that paid books are kept after delivery (the client's deletion table).
 */
export const MAX_OFFSET_HOURS: Record<ReminderKind, number> = {
  PREVIEW_UNFINISHED: 6 * 24,
  BOOK_NOT_SENT: 30 * 24,
  REVIEW_REQUEST: 40 * 24,
};

/**
 * An offset is only sent if it became due within this long, so switching a reminder on, lowering a send
 * time or an outage can never release a backlog onto old customers. Longer than the 13 hours of the
 * overnight pause (the send window is 9:00 to 20:00), so a reminder due at night still goes out next morning.
 */
export const CATCH_UP_WINDOW_MS = DAY_MS;

/** A reminder is skipped while the customer touched the session this recently: they are still active. */
export const PREVIEW_QUIET_GUARD_MS = HOUR_MS;

/**
 * A session in AWAITING_PAYMENT counts as unfinished only after its order has been left alone this long
 * (the customer opened the payment window and walked away). Closer than that and a payment may be in
 * progress or its webhook late: "you have not bought" would then reach someone who just paid.
 */
export const AWAITING_PAYMENT_SETTLE_MS = 2 * HOUR_MS;

/** A claimed reminder with no outcome after this long is marked LOST: it may or may not have been sent. */
export const CLAIM_LOST_AFTER_MS = HOUR_MS;

/** A run stops starting new sends after this long, inside the 120 s timeout of the scheduled sweeps. */
export const REMINDER_RUN_BUDGET_MS = 50_000;

/** The same address gets at most one new reminder in this long (a different session or kind). */
export const PER_ADDRESS_WINDOW_MS = DAY_MS;

/** Rows that hold an address are deleted after this long (the send logs); opt-outs are kept for good. */
export const SEND_ROWS_RETENTION_DAYS = 90;
/** Unsubscribe tokens outlive the send rows, so an old email's link still works. */
export const UNSUBSCRIBE_TOKEN_RETENTION_DAYS = 365;
/** A broadcast still SENDING after this long is cancelled, so a rollback and redeploy cannot resume it. */
export const BROADCAST_AUTO_CANCEL_DAYS = 7;

/** Resend's error name is stored, capped; the address and message text are never stored. */
export const MAX_ERROR_NAME_LENGTH = 200;

/**
 * A send that has not answered in this long is treated as "result unknown" (it stays claimed, is counted and
 * is never resent): a hung request must not hold the run, and the claims behind it, for ever.
 */
export const SEND_TIMEOUT_MS = 25_000;

/** The most paid orders looked at when leaving out addresses that have already bought (reminder A). */
export const PAID_ORDER_LOOKUP_LIMIT = 2_000;

/** Options of the claim transactions: the advisory lock can make a second instance wait for the first. */
export const CLAIM_TRANSACTION_OPTIONS = { maxWait: 20_000, timeout: 20_000 };

/** Limits an admin can set. */
export const MAX_DAILY_BUDGET = 1000;
export const MAX_PER_RUN_LIMIT = 50;
/** The most days a preview-deletion promise may name: a preview expires after 7 days (SESSION_LIFETIME_DAYS in session.service.ts). */
export const MAX_PREVIEW_DELETION_DAYS = 7;

/** Lock key for the claim step: one claim transaction at a time, across instances (pg_advisory_xact_lock). */
export const EMAIL_CLAIM_LOCK_KEY = "reminder-email-claim";

/** How far back the admin Emails report card looks. */
export const STATUS_LOOKBACK_DAYS = 30;

/** Options of the transaction that takes a broadcast's recipient snapshot (one insert per recipient). */
export const BROADCAST_START_TRANSACTION_OPTIONS = {
  maxWait: 20_000,
  timeout: 60_000,
};

/**
 * A run stops after this many sends in a row that went wrong without a clean answer: result unknown (Resend
 * or the network is down), refused for good (a setup error can look like one), or not preparable.
 */
export const MAX_CONSECUTIVE_TROUBLE = 3;

/** Resend errors that mean "nothing was sent, the sender is limited": release the claim and stop the run. */
export const RESEND_LIMIT_ERROR_NAMES = [
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "rate_limit_exceeded",
];

/**
 * Tag stored with a marketing consent: which text the customer saw next to the checkout box.
 * ⚠️ The text itself is in the frontend (components/checkout/MarketingOptIn.tsx). Change the text and this
 * version together, or a consent record names wording that was never shown.
 */
export const MARKETING_CONSENT_WORDING_VERSION = "v1";
