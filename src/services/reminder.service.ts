import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  EmailGuardRefusal,
  EmailSendError,
  isRecipientAllowed,
  sendEmail,
} from "../lib/email.js";
import {
  AWAITING_CUSTOMER_PRINT,
  AWAITING_PAYMENT_SETTLE_MS,
  CATCH_UP_WINDOW_MS,
  CLAIM_LOST_AFTER_MS,
  CLAIM_TRANSACTION_OPTIONS,
  DAY_MS,
  EMAIL_CLAIM_LOCK_KEY,
  HOUR_MS,
  MAX_CONSECUTIVE_TROUBLE,
  MAX_ERROR_NAME_LENGTH,
  PER_ADDRESS_WINDOW_MS,
  PREVIEW_QUIET_GUARD_MS,
  PAID_ORDER_LOOKUP_LIMIT,
  REMINDER_RUN_BUDGET_MS,
  SEND_TIMEOUT_MS,
  STATUS_LOOKBACK_DAYS,
  RESEND_LIMIT_ERROR_NAMES,
  SEND_ROWS_RETENTION_DAYS,
  UNSUBSCRIBE_TOKEN_RETENTION_DAYS,
} from "../config/reminders.js";
import type { Prisma, ReminderKind } from "../generated/prisma/client.js";
import { REPORTING_TIMEZONE } from "../config/stats.js";
import { isInsideSendWindow, istDayStart } from "../utils/reminderTime.js";
import { pickDueOffset } from "../utils/reminderSchedule.js";
import { getReminderSettings } from "./reminderSettings.service.js";
import { isPlaceholderAddress } from "../utils/emailAddress.js";
import { previewUrl, renderReminderEmail } from "./notification.service.js";
import { buildUnsubscribeLinks } from "./emailOptOut.service.js";

// ============================================================
// REMINDER EMAILS: select, claim, send (feature 5)
// ============================================================
//
// Exactly-once, in three steps (a send is claimed once, then made):
//   1. CLAIM: one short transaction, under a Postgres advisory lock shared by every instance, re-selects
//      what is due, applies the daily budget and the one-reminder-per-address rule, and inserts a
//      ReminderSend row for each. The unique key (kind, session, offset) means a reminder can be claimed
//      once. No external call inside the transaction.
//   2. SEND: Resend is called with the claim's id as its idempotency key, so a retry, a lost response or an
//      overlapping run cannot produce a second mail.
//   3. OUTCOME: SENT; or the claim is released (nothing was sent: the sender is limited, or the development
//      guard refused); or FAILED (Resend refused for good, never retried); or it stays CLAIMED (the result
//      is unknown) and becomes LOST after an hour. A LOST or FAILED offset is never retried: the next
//      offset is the retry.
// A reminder never reads or writes an order, a session or a payment: it only selects from them.

type Db = Prisma.TransactionClient;

/** Rows that count as a reminder having gone to an address (FAILED never reached the person). */
export const SPENT_STATUSES = ["CLAIMED", "SENT", "LOST"] as const;
/** The send-log statuses that stop an offset being sent again: any row at all means it was handled. */
const SEEN_STATUSES = ["CLAIMED", "SENT", "LOST", "FAILED"] as const;
/** Most customers one query looks at per kind: a safety bound, far above today's volume. */
const CANDIDATE_LIMIT = 500;

type Settings = Awaited<ReturnType<typeof getReminderSettings>>;

type DueReminder = {
  kind: ReminderKind;
  orderSessionId: string;
  /** The offset to send, in hours, and its place in the admin's list. */
  offsetHours: number;
  step: number;
  total: number;
  /** Lowercase recipient. */
  email: string;
  childName: string | null;
  bookTitle: string;
  coverUrl: string | null;
  /** Used for the deletion date of the last A reminder. */
  sessionCreatedAt: Date;
  sessionStatus: string;
  /** An earlier reminder of this kind already went (or was claimed) for this session. */
  alreadyReminded: boolean;
};

type KindConfig = {
  kind: ReminderKind;
  enabled: boolean;
  offsets: number[];
  effectiveFrom: Date | null;
};

function kindConfigs(settings: Settings): KindConfig[] {
  // Paid customers first: the book that waits for a "Send to Print" (B) and the review request (C) must
  // not be crowded out of a day's budget by a pile of unfinished previews (A), because an offset that is
  // not sent within its catch-up window is never sent.
  return [
    {
      kind: "BOOK_NOT_SENT",
      enabled: settings.bookEnabled,
      offsets: settings.bookOffsetsHours,
      effectiveFrom: settings.bookEffectiveFrom,
    },
    {
      kind: "REVIEW_REQUEST",
      enabled: settings.reviewEnabled,
      offsets: settings.reviewOffsetsHours,
      effectiveFrom: settings.reviewEffectiveFrom,
    },
    {
      kind: "PREVIEW_UNFINISHED",
      enabled: settings.previewEnabled,
      offsets: settings.previewOffsetsHours,
      effectiveFrom: settings.previewEffectiveFrom,
    },
  ];
}

/** The same fallback the six order emails use: the session's address, else the order's. Lowercase. */
function recipientOf(
  sessionEmail: string | null | undefined,
  orderEmail: string | null | undefined
): string | null {
  const email = sessionEmail?.trim() || orderEmail?.trim() || null;
  const lower = email ? email.toLowerCase() : null;
  return lower && !isPlaceholderAddress(lower) ? lower : null;
}

type Base = {
  orderSessionId: string;
  baseTime: Date;
  email: string | null;
  childName: string | null;
  bookTitle: string;
  coverUrl: string | null;
  sessionCreatedAt: Date;
  sessionStatus: string;
};

const COMIC_SELECT = {
  select: { title: true, coverThumbnailUrls: true },
} as const;

/** A: previews nobody bought, timed from the day the session was made. */
async function previewBases(
  db: Db,
  now: Date,
  maxOffset: number
): Promise<Base[]> {
  const sessions = await db.orderSession.findMany({
    where: {
      isSample: false,
      createdAt: {
        gte: new Date(now.getTime() - maxOffset * HOUR_MS - CATCH_UP_WINDOW_MS),
        lte: now,
      },
      // Skipped while the customer is still active.
      updatedAt: { lt: new Date(now.getTime() - PREVIEW_QUIET_GUARD_MS) },
      OR: [
        {
          status: "PREVIEW_READY",
          expiresAt: { gt: now },
          OR: [
            { order: { is: null } },
            { order: { is: { status: "CREATED", razorpayPaymentId: null } } },
          ],
        },
        {
          // The customer opened the payment window and left. Not closer than the settle time: a payment may
          // be in progress or its webhook late, and "you have not bought" must never reach someone who paid.
          status: "AWAITING_PAYMENT",
          order: {
            is: {
              status: "CREATED",
              razorpayPaymentId: null,
              updatedAt: {
                lt: new Date(now.getTime() - AWAITING_PAYMENT_SETTLE_MS),
              },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      status: true,
      notificationEmail: true,
      childName: true,
      order: { select: { notificationEmail: true } },
      comic: COMIC_SELECT,
    },
    orderBy: { createdAt: "asc" },
    take: CANDIDATE_LIMIT,
  });
  // A customer who made a second preview and paid for it must not be told, for the first, that they have not
  // bought: leave out every address with a paid order started after the earliest candidate was created.
  const boughtElsewhere = await addressesWithPaidOrderSince(
    db,
    sessions.length > 0 ? sessions[0]!.createdAt : now
  );
  return sessions
    .map((s) => ({
      s,
      email: recipientOf(s.notificationEmail, s.order?.notificationEmail),
    }))
    .filter(({ email }) => email === null || !boughtElsewhere.has(email))
    .map(({ s, email }) => ({
      orderSessionId: s.id,
      baseTime: s.createdAt,
      email,
      childName: s.childName,
      bookTitle: s.comic.title,
      coverUrl: s.comic.coverThumbnailUrls[0] ?? null,
      sessionCreatedAt: s.createdAt,
      sessionStatus: s.status,
    }));
}

/** Lowercase addresses (the session's or the order's) of paid orders created since `since`. */
async function addressesWithPaidOrderSince(
  db: Db,
  since: Date
): Promise<Set<string>> {
  const orders = await db.order.findMany({
    where: {
      status: { notIn: ["CREATED", "CANCELLED"] },
      createdAt: { gte: since },
      orderSession: { isSample: false },
    },
    select: {
      notificationEmail: true,
      orderSession: { select: { notificationEmail: true } },
    },
    take: PAID_ORDER_LOOKUP_LIMIT,
  });
  const emails = new Set<string>();
  for (const o of orders) {
    for (const raw of [o.notificationEmail, o.orderSession.notificationEmail]) {
      if (raw && raw.trim()) emails.add(raw.trim().toLowerCase());
    }
  }
  return emails;
}

const ORDER_SESSION_SELECT = {
  select: {
    id: true,
    createdAt: true,
    status: true,
    notificationEmail: true,
    childName: true,
    comic: COMIC_SELECT,
  },
} as const;

/** B: paid books that are ready and not sent to print, timed from the order's last update. */
async function bookBases(
  db: Db,
  now: Date,
  maxOffset: number
): Promise<Base[]> {
  const orders = await db.order.findMany({
    where: {
      status: AWAITING_CUSTOMER_PRINT.orderStatus,
      updatedAt: {
        gte: new Date(now.getTime() - maxOffset * HOUR_MS - CATCH_UP_WINDOW_MS),
        lte: now,
      },
      orderSession: {
        isSample: false,
        status: AWAITING_CUSTOMER_PRINT.sessionStatus,
      },
    },
    select: {
      updatedAt: true,
      notificationEmail: true,
      orderSession: ORDER_SESSION_SELECT,
    },
    orderBy: { updatedAt: "asc" },
    take: CANDIDATE_LIMIT,
  });
  const stops = await db.reminderStop.findMany({
    where: {
      kind: "BOOK_NOT_SENT",
      orderSessionId: { in: orders.map((o) => o.orderSession.id) },
    },
    select: { orderSessionId: true },
  });
  const stopped = new Set(stops.map((s) => s.orderSessionId));
  return orders
    .filter((o) => !stopped.has(o.orderSession.id))
    .map((o) => ({
      orderSessionId: o.orderSession.id,
      baseTime: o.updatedAt,
      email: recipientOf(o.orderSession.notificationEmail, o.notificationEmail),
      childName: o.orderSession.childName,
      bookTitle: o.orderSession.comic.title,
      coverUrl: null,
      sessionCreatedAt: o.orderSession.createdAt,
      sessionStatus: o.orderSession.status,
    }));
}

/** C: delivered orders, timed from the delivery. */
async function reviewBases(
  db: Db,
  now: Date,
  maxOffset: number
): Promise<Base[]> {
  const orders = await db.order.findMany({
    where: {
      status: "DELIVERED",
      deliveredAt: {
        not: null,
        gte: new Date(now.getTime() - maxOffset * HOUR_MS - CATCH_UP_WINDOW_MS),
        lte: now,
      },
      orderSession: { isSample: false },
    },
    select: {
      deliveredAt: true,
      notificationEmail: true,
      orderSession: ORDER_SESSION_SELECT,
    },
    orderBy: { deliveredAt: "asc" },
    take: CANDIDATE_LIMIT,
  });
  return orders.flatMap((o) =>
    o.deliveredAt
      ? [
          {
            orderSessionId: o.orderSession.id,
            baseTime: o.deliveredAt,
            email: recipientOf(
              o.orderSession.notificationEmail,
              o.notificationEmail
            ),
            childName: o.orderSession.childName,
            bookTitle: o.orderSession.comic.title,
            coverUrl: null,
            sessionCreatedAt: o.orderSession.createdAt,
            sessionStatus: o.orderSession.status,
          },
        ]
      : []
  );
}

/**
 * Everything due right now, across the enabled reminders: by kind (B, then C, then A, see kindConfigs), and
 * oldest first within a kind. Pure selection: it changes nothing.
 * `db` is the transaction in the claim step (authoritative) and the plain client in the cheap pre-check.
 */
async function findDueReminders(
  db: Db,
  settings: Settings,
  now: Date
): Promise<DueReminder[]> {
  const due: DueReminder[] = [];

  for (const cfg of kindConfigs(settings)) {
    if (!cfg.enabled || cfg.offsets.length === 0 || cfg.effectiveFrom === null)
      continue;
    const maxOffset = Math.max(...cfg.offsets);
    const bases =
      cfg.kind === "PREVIEW_UNFINISHED"
        ? await previewBases(db, now, maxOffset)
        : cfg.kind === "BOOK_NOT_SENT"
          ? await bookBases(db, now, maxOffset)
          : await reviewBases(db, now, maxOffset);
    if (bases.length >= CANDIDATE_LIMIT) {
      // More customers in the window than one look can hold: the newest may wait. Not an error today.
      logger.warn(
        { kind: cfg.kind, limit: CANDIDATE_LIMIT },
        "[Reminders] Candidate limit reached: the newest customers may wait for a later run"
      );
    }
    if (bases.length === 0) continue;

    // What was already handled for these customers: any row at all consumes that offset.
    const seen = await db.reminderSend.findMany({
      where: {
        kind: cfg.kind,
        orderSessionId: { in: bases.map((b) => b.orderSessionId) },
        status: { in: [...SEEN_STATUSES] },
      },
      select: { orderSessionId: true, offsetHours: true, status: true },
    });
    const seenBySession = new Map<string, number[]>();
    // Sessions where an earlier reminder was really delivered (or may have been): a refused one never reached
    // the customer, so it does not make the next one a "final" reminder.
    const remindedSessions = new Set<string>();
    for (const row of seen) {
      seenBySession.set(row.orderSessionId, [
        ...(seenBySession.get(row.orderSessionId) ?? []),
        row.offsetHours,
      ]);
      if (row.status !== "FAILED") remindedSessions.add(row.orderSessionId);
    }

    // Reminder B is about a paid order, so a general opt-out does not stop it (its own per-book stop does).
    const optedOut =
      cfg.kind === "BOOK_NOT_SENT"
        ? new Set<string>()
        : new Set(
            (
              await db.emailOptOut.findMany({
                where: {
                  email: {
                    in: bases.flatMap((b) => (b.email ? [b.email] : [])),
                  },
                },
                select: { email: true },
              })
            ).map((o) => o.email)
          );

    for (const base of bases) {
      if (!base.email || optedOut.has(base.email)) continue;
      const offset = pickDueOffset({
        offsetsHours: cfg.offsets,
        baseTime: base.baseTime,
        now,
        effectiveFrom: cfg.effectiveFrom,
        catchUpMs: CATCH_UP_WINDOW_MS,
        claimedOffsets: seenBySession.get(base.orderSessionId) ?? [],
      });
      if (offset === null) continue;
      due.push({
        kind: cfg.kind,
        orderSessionId: base.orderSessionId,
        offsetHours: offset,
        step: cfg.offsets.indexOf(offset),
        total: cfg.offsets.length,
        email: base.email,
        childName: base.childName,
        bookTitle: base.bookTitle,
        coverUrl: base.coverUrl,
        sessionCreatedAt: base.sessionCreatedAt,
        sessionStatus: base.sessionStatus,
        alreadyReminded: remindedSessions.has(base.orderSessionId),
      });
    }
  }
  return due;
}

export type ClaimedReminder = DueReminder & { claimId: string };

/** How much of the day's budget is used: reminders spent, and broadcast recipients claimed or sent. */
export async function countBudgetUsed(db: Db, dayStart: Date) {
  const [reminders, broadcast] = await Promise.all([
    db.reminderSend.count({
      where: {
        claimedAt: { gte: dayStart },
        status: { in: [...SPENT_STATUSES] },
      },
    }),
    db.broadcastRecipient.count({
      where: {
        claimedAt: { gte: dayStart },
        status: { in: ["CLAIMED", "SENT"] },
      },
    }),
  ]);
  return { reminders, broadcast };
}

/**
 * Step 1. Claims what may go out now: at most `perRunLimit`, never past the day's budget, and at most one
 * new reminder per address in 24 hours (a second session or kind for the same address waits; the same
 * session's next offset is the admin's own cadence and is not held back). Reminders may use the whole
 * budget; a broadcast only budget minus the reserve (services/broadcast), so it cannot starve them.
 */
export async function claimDueReminders(
  settings: Settings,
  now: Date
): Promise<ClaimedReminder[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EMAIL_CLAIM_LOCK_KEY}))`;

    const dayStart = istDayStart(now);
    const { reminders: reminderUsed, broadcast: broadcastUsed } =
      await countBudgetUsed(tx, dayStart);
    const slots = Math.min(
      settings.perRunLimit,
      settings.dailyBudget - reminderUsed - broadcastUsed
    );
    if (slots <= 0) return [];

    // Re-select under the lock: this is the authoritative list, the earlier check was only a look.
    const due = await findDueReminders(tx, settings, now);
    if (due.length === 0) return [];

    const recent = await tx.reminderSend.findMany({
      where: {
        email: { in: due.map((d) => d.email) },
        claimedAt: { gt: new Date(now.getTime() - PER_ADDRESS_WINDOW_MS) },
        status: { in: [...SPENT_STATUSES] },
      },
      select: { email: true, kind: true, orderSessionId: true },
    });

    const chosen: ClaimedReminder[] = [];
    const takenThisRun = new Set<string>();
    for (const item of due) {
      if (chosen.length >= slots) break;
      if (takenThisRun.has(item.email)) continue;
      // Outside production only allow-listed addresses can be mailed: leave the rest unclaimed, so they
      // cannot take slots from the ones that can.
      if (!isRecipientAllowed(item.email)) continue;
      const heldByAnother = recent.some(
        (r) =>
          r.email === item.email &&
          !(r.kind === item.kind && r.orderSessionId === item.orderSessionId)
      );
      if (heldByAnother) continue;
      takenThisRun.add(item.email);
      chosen.push({ ...item, claimId: randomUUID() });
    }
    if (chosen.length === 0) return [];

    await tx.reminderSend.createMany({
      data: chosen.map((c) => ({
        id: c.claimId,
        kind: c.kind,
        orderSessionId: c.orderSessionId,
        offsetHours: c.offsetHours,
        email: c.email,
        status: "CLAIMED" as const,
        claimedAt: now,
      })),
      skipDuplicates: true,
    });
    // skipDuplicates hides a conflict: keep only the claims that really went in.
    const inserted = await tx.reminderSend.findMany({
      where: { id: { in: chosen.map((c) => c.claimId) } },
      select: { id: true },
    });
    const insertedIds = new Set(inserted.map((r) => r.id));
    return chosen.filter((c) => insertedIds.has(c.claimId));
  }, CLAIM_TRANSACTION_OPTIONS);
}

function formatDeletionDate(createdAt: Date, days: number): string {
  return new Date(createdAt.getTime() + days * DAY_MS).toLocaleDateString(
    "en-IN",
    {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: REPORTING_TIMEZONE,
    }
  );
}

/** A coupon code worth showing: it exists, is switched on, is in its dates and is open to everyone. */
async function usableCouponCode(
  code: string | null,
  now: Date
): Promise<string | null> {
  if (!code) return null;
  const coupon = await prisma.coupon.findUnique({
    where: { code },
    select: {
      code: true,
      isActive: true,
      startsAt: true,
      endsAt: true,
      restrictedToUserId: true,
      kind: true,
      usageLimit: true,
      allComics: true,
      countryCodes: true,
      coverTypes: true,
      firstOrderOnly: true,
      perCustomerLimit: true,
      currency: true,
    },
  });
  // Only a code that works for every book, country and cover, for anyone, with no total cap that may have
  // run out: a last-chance email must never hand over a code that checkout then refuses.
  if (
    !coupon ||
    !coupon.isActive ||
    coupon.kind !== "PUBLIC" ||
    coupon.usageLimit !== null ||
    !coupon.allComics ||
    coupon.countryCodes.length > 0 ||
    coupon.coverTypes.length > 0 ||
    coupon.firstOrderOnly ||
    coupon.perCustomerLimit !== null ||
    coupon.currency !== null || // a fixed amount is in one currency: it fails for a customer paying in another
    coupon.restrictedToUserId !== null ||
    (coupon.startsAt && coupon.startsAt > now) ||
    (coupon.endsAt && coupon.endsAt < now)
  ) {
    return null;
  }
  return coupon.code;
}

/** Resend's error name is stored capped; never its message (it can hold the address). */
export const capErrorName = (text: string) =>
  text.slice(0, MAX_ERROR_NAME_LENGTH);

/**
 * What a Resend error means for the send that got it:
 *  - "limited": the account's quota or rate limit (nothing was sent; try again later);
 *  - "config": the account is set up wrongly (bad or restricted key, unverified domain, testing mode), HTTP
 *    401 or 403: every further send fails the same way, so the run stops and nothing is marked failed;
 *  - "refused": Resend rejected this one message for good (a bad address, a bad parameter);
 *  - "unknown": anything else, including a 409 idempotency conflict, where the first attempt may have gone
 *    through, so the send must not be called failed.
 */
type ResendFailure = "limited" | "config" | "refused" | "unknown";

export function classifyResendError(err: EmailSendError): ResendFailure {
  if (
    RESEND_LIMIT_ERROR_NAMES.includes(err.providerName) ||
    err.providerStatus === 429
  ) {
    return "limited";
  }
  if (err.providerStatus === 401 || err.providerStatus === 403) return "config";
  if (err.providerStatus === 409) return "unknown";
  if (err.providerStatus >= 400 && err.providerStatus < 500) return "refused";
  return "unknown";
}

/** Outcomes that are not a clean send or a clean release: a run that meets several in a row stops. */
export const isTrouble = (outcome: SendOutcome) =>
  outcome === "unknown" || outcome === "failed" || outcome === "prep_failed";

export function withSendTimeout<T>(
  promise: Promise<T>,
  ms = SEND_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("send timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What one send came to; shared with the broadcast, which sends the same way. */
export type SendOutcome =
  | "sent"
  | "released"
  | "failed"
  | "unknown"
  | "limited"
  | "prep_failed";

/**
 * Steps 2 and 3 for one claim. Never throws. "limited" tells the caller to stop the run (Resend says the
 * account is limited, so nothing was sent and every further send would fail the same way).
 */
async function sendClaimedReminder(
  claim: ClaimedReminder,
  settings: Settings,
  now: Date
): Promise<SendOutcome> {
  // Everything before the send (the unsubscribe link, the coupon, the render) touches only our own database
  // and code. If any of it fails nothing was sent, so the claim is given back rather than left as an
  // unknown send result that would be counted, lost after an hour and never retried.
  let prepared: {
    subject: string;
    html: string;
    headers?: Record<string, string>;
  };
  try {
    const isReview = claim.kind === "REVIEW_REQUEST";
    const reviewUrl = settings.googleReviewUrl;
    if (isReview && !reviewUrl) {
      // Cannot happen through the settings service (it refuses to switch C on without a link), but a
      // missing link must never send a reminder whose button goes nowhere.
      await prisma.reminderSend.deleteMany({
        where: { id: claim.claimId, status: "CLAIMED" },
      });
      return "released";
    }

    // B is about a paid order, not marketing: its link is per order and it carries no one-click header.
    const isBook = claim.kind === "BOOK_NOT_SENT";
    const unsubscribe = await buildUnsubscribeLinks(
      claim.email,
      isBook ? "ORDER_REMINDER" : "GLOBAL",
      isBook ? claim.orderSessionId : null,
      !isBook
    );
    const isLastPreview =
      claim.kind === "PREVIEW_UNFINISHED" &&
      claim.step >= claim.total - 1 &&
      claim.total > 1;
    const email = renderReminderEmail({
      kind: claim.kind,
      step: claim.step,
      total: claim.total,
      childName: claim.childName,
      bookTitle: claim.bookTitle,
      coverUrl: claim.coverUrl,
      link:
        isReview && reviewUrl ? reviewUrl : previewUrl(claim.orderSessionId),
      // A promise of deletion only while the preview is still inside its days, and only if the admin says
      // previews really are deleted (nothing else deletes them yet).
      deletionDate:
        isLastPreview &&
        claim.sessionStatus === "PREVIEW_READY" &&
        settings.previewDeletionDays
          ? formatDeletionDate(
              claim.sessionCreatedAt,
              settings.previewDeletionDays
            )
          : null,
      couponCode: isLastPreview
        ? await usableCouponCode(settings.reminderCouponCode, now)
        : null,
      stopUrl: unsubscribe.stopUrl,
      alreadyReminded: claim.alreadyReminded,
    });
    prepared = { ...email, headers: unsubscribe.headers };
  } catch (err) {
    logger.error(
      { claimId: claim.claimId, err },
      "[Reminders] Could not prepare a reminder: claim released, nothing sent"
    );
    await prisma.reminderSend
      .deleteMany({ where: { id: claim.claimId, status: "CLAIMED" } })
      .catch((releaseErr) =>
        logger.error(
          { claimId: claim.claimId, err: releaseErr },
          "[Reminders] Could not release the claim either: it will be lost after an hour"
        )
      );
    return "prep_failed";
  }

  try {
    const result = await withSendTimeout(
      sendEmail({
        to: claim.email,
        subject: prepared.subject,
        html: prepared.html,
        idempotencyKey: claim.claimId,
        ...(prepared.headers ? { headers: prepared.headers } : {}),
      })
    );

    await prisma.reminderSend.updateMany({
      where: { id: claim.claimId, status: "CLAIMED" },
      data: {
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: result.messageId,
      },
    });
    return "sent";
  } catch (err) {
    // Nothing was sent: the development guard refused. Not a failure and not a reason to suppress anyone.
    if (err instanceof EmailGuardRefusal) {
      await prisma.reminderSend.deleteMany({
        where: { id: claim.claimId, status: "CLAIMED" },
      });
      return "released";
    }
    if (err instanceof EmailSendError) {
      const failure = classifyResendError(err);
      if (failure === "limited" || failure === "config") {
        // Nothing was sent. Give the claim back and stop the run: every further send would get the same answer.
        await prisma.reminderSend.deleteMany({
          where: { id: claim.claimId, status: "CLAIMED" },
        });
        logger[failure === "config" ? "error" : "warn"](
          {
            claimId: claim.claimId,
            provider: err.providerName,
            status: err.providerStatus,
          },
          failure === "config"
            ? "[Reminders] Resend rejected the account setup (key or domain): run stopped, claim released"
            : "[Reminders] Resend is limiting this account: run stopped, claim released"
        );
        return "limited";
      }
      if (failure === "refused") {
        // Resend refused this message for good. Never retried. The address is NOT suppressed.
        await prisma.reminderSend.updateMany({
          where: { id: claim.claimId, status: "CLAIMED" },
          data: { status: "FAILED", errorName: capErrorName(err.providerName) },
        });
        logger.error(
          {
            claimId: claim.claimId,
            provider: err.providerName,
            status: err.providerStatus,
          },
          "[Reminders] Resend refused a reminder"
        );
        return "failed";
      }
    }
    // The result is unknown (network, 5xx, anything unexpected): leave the claim as it is. The idempotency
    // key protects any retry inside sendEmail; the claim becomes LOST after an hour and is never resent.
    logger.error(
      { claimId: claim.claimId, err },
      "[Reminders] Send result unknown, claim left as is"
    );
    return "unknown";
  }
}

/** Marks claims with no outcome after an hour as LOST (they still count against the day's budget). */
export async function markLostClaims(now: Date): Promise<number> {
  const { count } = await prisma.reminderSend.updateMany({
    where: {
      status: "CLAIMED",
      claimedAt: { lt: new Date(now.getTime() - CLAIM_LOST_AFTER_MS) },
    },
    data: { status: "LOST" },
  });
  return count;
}

/**
 * Deletes send logs older than 90 days and unsubscribe tokens older than a year. Opt-outs are kept. Runs
 * on every sweep: the three deletes use indexed date columns and find nothing on almost every run.
 */
export async function purgeOldEmailRows(now: Date): Promise<void> {
  const sendCutoff = new Date(
    now.getTime() - SEND_ROWS_RETENTION_DAYS * DAY_MS
  );
  await prisma.reminderSend.deleteMany({
    where: { claimedAt: { lt: sendCutoff } },
  });
  await prisma.broadcastRecipient.deleteMany({
    where: { createdAt: { lt: sendCutoff } },
  });
  await prisma.emailUnsubscribeToken.deleteMany({
    where: {
      createdAt: {
        lt: new Date(now.getTime() - UNSUBSCRIBE_TOKEN_RETENTION_DAYS * DAY_MS),
      },
    },
  });
}

/**
 * One run of the reminder sweep. Returns how many reminders were sent. Housekeeping always runs; sending
 * only inside the daily window and only when something is switched on and due. Stops starting new sends
 * after REMINDER_RUN_BUDGET_MS (the 120 s timeout of the scheduled sweeps cannot cancel a hung run).
 */
export async function sweepReminders(
  now: Date = new Date(),
  runBudgetMs: number = REMINDER_RUN_BUDGET_MS
): Promise<number> {
  const startedAt = Date.now();

  // Housekeeping must never stop the sending: a slow or failing cleanup is logged and tried again next run.
  try {
    await markLostClaims(now);
    await purgeOldEmailRows(now);
  } catch (err) {
    logger.error({ err }, "[Reminders] Housekeeping failed, sending goes on");
  }

  const settings = await getReminderSettings();
  if (!kindConfigs(settings).some((c) => c.enabled)) return 0;
  if (
    !isInsideSendWindow(now, settings.windowStartHour, settings.windowEndHour)
  )
    return 0;

  // A cheap look first, so a quiet run does not take the lock at all.
  if ((await findDueReminders(prisma, settings, now)).length === 0) return 0;

  const claims = await claimDueReminders(settings, now);
  let sent = 0;
  let attempted = 0;
  let troubleInARow = 0;
  for (const claim of claims) {
    if (Date.now() - startedAt > runBudgetMs) {
      logger.warn(
        "[Reminders] Run time used up, the claims not yet tried are released"
      );
      break;
    }
    attempted += 1;
    const outcome = await sendClaimedReminder(claim, settings, now);
    if (outcome === "sent") sent += 1;
    if (outcome === "limited") break;
    troubleInARow = isTrouble(outcome) ? troubleInARow + 1 : 0;
    if (troubleInARow >= MAX_CONSECUTIVE_TROUBLE) {
      logger.error(
        "[Reminders] Several sends in a row went wrong (no answer, a refusal or a failed preparation): run stopped"
      );
      break;
    }
  }
  // Claims this run never tried were never sent: give them back so they are neither lost nor counted
  // against the day's budget, and are picked up by the next run.
  const untried = claims.slice(attempted);
  if (untried.length > 0) {
    await prisma.reminderSend.deleteMany({
      where: { id: { in: untried.map((c) => c.claimId) }, status: "CLAIMED" },
    });
  }
  if (claims.length > 0) {
    logger.info({ claimed: claims.length, sent }, "[Reminders] Sweep finished");
  }
  return sent;
}

/**
 * For the admin Emails page: today's use of the daily budget and what would go out if a run happened now.
 * Read-only; "due now" ignores the send window and the budget, so it shows what is waiting, not what is
 * sent in this minute.
 */
export async function getReminderStatus(now: Date = new Date()) {
  const settings = await getReminderSettings();
  const dayStart = istDayStart(now);
  const since = new Date(now.getTime() - STATUS_LOOKBACK_DAYS * DAY_MS);

  const [sentToday, used, due, optedOut, recentSends, failedRecently] =
    await Promise.all([
      prisma.reminderSend.groupBy({
        by: ["kind", "status"],
        where: { claimedAt: { gte: dayStart } },
        _count: { _all: true },
      }),
      countBudgetUsed(prisma, dayStart),
      findDueReminders(prisma, settings, now),
      prisma.emailOptOut.count(),
      prisma.reminderSend.findMany({
        where: {
          kind: "PREVIEW_UNFINISHED",
          status: "SENT",
          sentAt: { gte: since },
        },
        select: { orderSessionId: true },
      }),
      prisma.reminderSend.count({
        where: { status: "FAILED", claimedAt: { gte: since } },
      }),
    ]);

  // "Bought after a reminder": the unfinished-preview reminder is only ever sent while the session has no
  // paid order, so a session that now has one was paid after the reminder. It says the reminder was
  // followed by a purchase, not that it caused it.
  const paidSessions = recentSends.length
    ? await prisma.order.findMany({
        where: {
          orderSessionId: { in: recentSends.map((r) => r.orderSessionId) },
          status: { notIn: ["CREATED", "CANCELLED"] },
        },
        select: { orderSessionId: true },
      })
    : [];
  const paidSessionIds = new Set(paidSessions.map((o) => o.orderSessionId));
  const boughtAfterReminder = new Set(
    recentSends
      .map((r) => r.orderSessionId)
      .filter((id) => paidSessionIds.has(id))
  ).size;

  const dueNow: Record<ReminderKind, number> = {
    PREVIEW_UNFINISHED: 0,
    BOOK_NOT_SENT: 0,
    REVIEW_REQUEST: 0,
  };
  for (const item of due) dueNow[item.kind] += 1;

  return {
    budget: {
      daily: settings.dailyBudget,
      reserve: settings.reminderReserve,
      remindersToday: used.reminders,
      broadcastToday: used.broadcast,
    },
    dueNow,
    today: sentToday.map((row) => ({
      kind: row.kind,
      status: row.status,
      count: row._count._all,
    })),
    // The last STATUS_LOOKBACK_DAYS days, for the report card.
    recent: {
      days: STATUS_LOOKBACK_DAYS,
      sentPreviewReminders: recentSends.length,
      boughtAfterReminder,
      refused: failedRecently,
      optedOutTotal: optedOut,
    },
  };
}
