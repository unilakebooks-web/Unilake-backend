import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import {
  devAllowedRecipients,
  EmailGuardRefusal,
  EmailSendError,
  sendEmail,
} from "../lib/email.js";
import {
  BROADCAST_AUTO_CANCEL_DAYS,
  CLAIM_LOST_AFTER_MS,
  BROADCAST_START_TRANSACTION_OPTIONS,
  CLAIM_TRANSACTION_OPTIONS,
  DAY_MS,
  EMAIL_CLAIM_LOCK_KEY,
  MAX_CONSECUTIVE_TROUBLE,
  PER_ADDRESS_WINDOW_MS,
  REMINDER_RUN_BUDGET_MS,
} from "../config/reminders.js";
import type {
  BroadcastAudience,
  OrderStatus,
} from "../generated/prisma/client.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import { isPlaceholderAddress } from "../utils/emailAddress.js";
import { isInsideSendWindow, istDayStart } from "../utils/reminderTime.js";
import { renderBroadcastEmail } from "./notification.service.js";
import {
  capErrorName,
  classifyResendError,
  isTrouble,
  withSendTimeout,
  countBudgetUsed,
  SPENT_STATUSES,
  type SendOutcome,
} from "./reminder.service.js";
import {
  buildUnsubscribeLinks,
  isTrustedAddressUser,
  TRUSTED_ADDRESS_USER,
} from "./emailOptOut.service.js";
import { getReminderSettings } from "./reminderSettings.service.js";
import type {
  CreateBroadcastInput,
  UpdateBroadcastInput,
} from "../validators/broadcast.schema.js";

// ============================================================
// ADMIN BROADCAST (email D, feature 5)
// ============================================================
//
// An admin writes one email and sends it to an audience. The recipients are a snapshot taken at Send; each
// sweep run then claims the next batch under the same lock, budget and idempotency key as the reminders
// (services/reminder.service.ts), so a broadcast can never starve a due reminder and can never mail anyone
// twice. A cancelled broadcast is checked again before every single send.

/** Staff accounts never receive a broadcast, even if they ticked the marketing box. */
const STAFF_ROLES = ["ADMIN", "SUB_ADMIN"];

/** An order in one of these states means the user really bought (not CREATED, not CANCELLED). */
const CUSTOMER_ORDER_STATUSES: OrderStatus[] = [
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
];

/**
 * Stored on a recipient the development guard refused (never in production). Unlike a reminder, whose claim
 * is released, the recipient is marked FAILED: a refused address would otherwise be picked first on every
 * run and stall the allowed ones behind it.
 */
const DEV_GUARD_ERROR_NAME = "not_allowed_in_development";

/**
 * The claim looks at more candidates than it has slots, because some are dropped on the way (opted out,
 * consent withdrawn) or are a second row for an address already taken in this run.
 */
const CANDIDATE_LOOKAHEAD_FACTOR = 4;
const CANDIDATE_LOOKAHEAD_EXTRA = 20;

const clean = (email: string) => email.trim().toLowerCase();

async function optedOutEmails(): Promise<Set<string>> {
  const rows = await prisma.emailOptOut.findMany({ select: { email: true } });
  return new Set(rows.map((r) => r.email));
}

/**
 * Every address we know for these users: the account address, and the notification address of each of their
 * sessions and orders (a reminder goes there, so an unsubscribe is stored for it; D-122). One read, lowercase.
 */
async function knownAddressesByUser(
  db: Pick<typeof prisma, "orderSession">,
  userIds: string[]
): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>();
  if (userIds.length === 0) return byUser;
  const sessions = await db.orderSession.findMany({
    where: { userId: { in: userIds } },
    select: {
      userId: true,
      notificationEmail: true,
      order: { select: { notificationEmail: true } },
    },
  });
  for (const s of sessions) {
    if (!s.userId) continue;
    const set = byUser.get(s.userId) ?? new Set<string>();
    for (const e of [s.notificationEmail, s.order?.notificationEmail]) {
      if (e && clean(e)) set.add(clean(e));
    }
    byUser.set(s.userId, set);
  }
  return byUser;
}

/** Emails (with the user's id) of users who ticked the box and have not withdrawn, staff left out. */
async function consentedEmails(): Promise<Map<string, string>> {
  const consents = await prisma.marketingConsent.findMany({
    where: { withdrawnAt: null },
    select: { userId: true },
  });
  if (consents.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: {
      id: { in: consents.map((c) => c.userId) },
      role: { notIn: STAFF_ROLES },
      // A tick counts only for an address that is the person's own (see setMarketingConsent).
      AND: [TRUSTED_ADDRESS_USER],
    },
    select: { id: true, email: true },
  });
  return new Map(
    users
      .map((u) => [clean(u.email), u.id] as [string, string])
      .filter(([e]) => e && !isPlaceholderAddress(e))
  );
}

/** Users who ticked the box and then unticked it (or unsubscribed): an explicit withdrawal, whatever they bought. */
async function withdrawnUserIds(): Promise<string[]> {
  const rows = await prisma.marketingConsent.findMany({
    where: { withdrawnAt: { not: null } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function customerEmails(): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({
    where: {
      role: { notIn: STAFF_ROLES },
      id: { notIn: await withdrawnUserIds() },
      // A customer's account address must be trusted too (see setMarketingConsent).
      AND: [TRUSTED_ADDRESS_USER],
      orderSessions: {
        some: {
          isSample: false,
          order: { is: { status: { in: CUSTOMER_ORDER_STATUSES } } },
        },
      },
    },
    select: { id: true, email: true },
  });
  return new Map(
    users
      .map((u) => [clean(u.email), u.id] as [string, string])
      .filter(([e]) => e && !isPlaceholderAddress(e))
  );
}

/**
 * Who would receive a broadcast to this audience right now. Anyone who opted out is always left out, and so is
 * a customer with a global opt-out on ANY of their known addresses (D-122). The per-order stop of reminder B
 * is not in the opt-out list and never removes anyone here.
 */
export async function resolveAudience(
  audience: BroadcastAudience
): Promise<string[]> {
  const [optedOut, consented] = await Promise.all([
    optedOutEmails(),
    consentedEmails(),
  ]);
  const all = new Map(consented);
  if (audience === "OPTED_IN_AND_CUSTOMERS") {
    for (const [email, userId] of await customerEmails())
      all.set(email, userId);
  }
  const known = await knownAddressesByUser(prisma, [...new Set(all.values())]);
  const silenced = (userId: string) =>
    [...(known.get(userId) ?? [])].some((e) => optedOut.has(e));
  return [...all]
    .filter(([email, userId]) => !optedOut.has(email) && !silenced(userId))
    .map(([email]) => email)
    .sort();
}

/** Both counts, so the admin sees how small the audience is before choosing. */
export async function getAudienceCounts() {
  const [optedInOnly, optedInAndCustomers] = await Promise.all([
    resolveAudience("OPTED_IN_ONLY"),
    resolveAudience("OPTED_IN_AND_CUSTOMERS"),
  ]);
  const settings = await getReminderSettings();
  return {
    optedInOnly: optedInOnly.length,
    optedInAndCustomers: optedInAndCustomers.length,
    // What a broadcast may send in a day at the current limits (the rest of the budget is the reminders').
    dailyCapacity: broadcastDailyCapacity(settings),
  };
}

// ── Draft management ────────────────────────────────────────

/** What a broadcast may send in a day: the daily budget minus the part kept for reminders. */
const broadcastDailyCapacity = (settings: {
  dailyBudget: number;
  reminderReserve: number;
}): number => Math.max(0, settings.dailyBudget - settings.reminderReserve);

/** Newest broadcasts shown in the admin list. A shop sends a few a month, so there is no paging. */
const BROADCAST_LIST_LIMIT = 100;

export async function listBroadcasts() {
  return prisma.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: BROADCAST_LIST_LIMIT,
  });
}

export async function getBroadcast(id: string) {
  const broadcast = await prisma.broadcast.findUnique({ where: { id } });
  if (!broadcast) throw new NotFoundError("Broadcast not found");
  const grouped = await prisma.broadcastRecipient.groupBy({
    by: ["status"],
    where: { broadcastId: id },
    _count: { _all: true },
  });
  const count = (status: string) =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;
  return {
    ...broadcast,
    progress: {
      pending: count("PENDING"),
      claimed: count("CLAIMED"),
      sent: count("SENT"),
      failed: count("FAILED"),
    },
  };
}

export async function createBroadcast(
  data: CreateBroadcastInput,
  admin: { id: string; email: string }
) {
  return prisma.broadcast.create({
    data: {
      subject: data.subject,
      heading: data.heading,
      message: data.message,
      buttonText: data.buttonText ?? null,
      buttonUrl: data.buttonUrl ?? null,
      audience: data.audience ?? "OPTED_IN_ONLY",
      createdById: admin.id,
      createdByEmail: clean(admin.email),
    },
  });
}

async function requireDraft(id: string) {
  const broadcast = await prisma.broadcast.findUnique({ where: { id } });
  if (!broadcast) throw new NotFoundError("Broadcast not found");
  if (broadcast.status !== "DRAFT") {
    throw new ConflictError(
      "Only a draft can be changed. This broadcast has already been started."
    );
  }
  return broadcast;
}

export async function updateBroadcast(id: string, data: UpdateBroadcastInput) {
  const current = await requireDraft(id);
  const buttonText =
    data.buttonText === undefined ? current.buttonText : data.buttonText;
  const buttonUrl =
    data.buttonUrl === undefined ? current.buttonUrl : data.buttonUrl;
  if ((buttonText == null) !== (buttonUrl == null)) {
    throw new ValidationError(
      "Give both the button text and the button link, or neither"
    );
  }
  // Guarded on the status, so a Send that lands between the read and the write cannot be edited under.
  const { count } = await prisma.broadcast.updateMany({
    where: { id, status: "DRAFT" },
    data,
  });
  if (count === 0)
    throw new ConflictError("This broadcast has already been started.");
  return prisma.broadcast.findUniqueOrThrow({ where: { id } });
}

export async function deleteBroadcastDraft(id: string) {
  await requireDraft(id);
  const { count } = await prisma.broadcast.deleteMany({
    where: { id, status: "DRAFT" },
  });
  if (count === 0)
    throw new ConflictError("This broadcast has already been started.");
}

// ── Preview and test ────────────────────────────────────────

/** The footer link of a preview or a test goes to the unsubscribe page without a token: it does nothing. */
const inertStopUrl = () => `${config.frontendUrl}/unsubscribe`;

export async function previewBroadcast(id: string) {
  const b = await prisma.broadcast.findUnique({ where: { id } });
  if (!b) throw new NotFoundError("Broadcast not found");
  return renderBroadcastEmail({
    subject: b.subject,
    heading: b.heading,
    message: b.message,
    buttonText: b.buttonText,
    buttonUrl: b.buttonUrl,
    optedIn: true,
    stopUrl: inertStopUrl(),
  });
}

/**
 * Sends the broadcast to the signed-in admin's own login address and nobody else (the route takes no
 * address). No recipient row, not counted against the budget, still subject to the development guard.
 */
export async function sendTestBroadcast(id: string, adminEmail: string) {
  const to = clean(adminEmail);
  if (!to)
    throw new ValidationError(
      "Your account has no email address to send the test to."
    );
  const { subject, html } = await previewBroadcast(id);
  try {
    await sendEmail({ to, subject: `[Test] ${subject}`, html });
    return { sent: true as const };
  } catch (err) {
    if (err instanceof EmailGuardRefusal) {
      return {
        sent: false as const,
        reason:
          "Not sent: this environment only mails addresses on its allow list.",
      };
    }
    if (err instanceof EmailSendError) {
      return {
        sent: false as const,
        reason: `Not sent: the email service refused it (${capErrorName(err.providerName)}).`,
      };
    }
    logger.error({ err }, "[Broadcast] Test send failed");
    return {
      sent: false as const,
      reason: "Not sent: the email service could not be reached.",
    };
  }
}

// ── Start, cancel ───────────────────────────────────────────

/**
 * Takes the snapshot and starts sending. `confirmRecipientCount` is what the admin saw: if the list has
 * changed since, nothing starts and the admin is asked to look again.
 */
export async function startBroadcast(
  id: string,
  confirmRecipientCount: number
) {
  const broadcast = await requireDraft(id);
  const emails = await resolveAudience(broadcast.audience);
  if (emails.length === 0)
    throw new ValidationError("There is nobody to send this to yet.");
  // A broadcast is cancelled after BROADCAST_AUTO_CANCEL_DAYS, so one that cannot finish by then is refused
  // now instead of silently leaving most people unmailed.
  const capacity = broadcastDailyCapacity(await getReminderSettings());
  if (capacity < 1) {
    throw new ValidationError(
      "The daily budget leaves no room for broadcasts. Raise it on the Reminders tab."
    );
  }
  const days = Math.ceil(emails.length / capacity);
  if (days > BROADCAST_AUTO_CANCEL_DAYS) {
    throw new ConflictError(
      `At the current limits (${capacity} a day) this would take about ${days} days, more than the ${BROADCAST_AUTO_CANCEL_DAYS} days a broadcast is kept. Raise the daily budget on the Reminders tab, or choose the smaller audience.`
    );
  }
  if (emails.length !== confirmRecipientCount) {
    throw new ConflictError(
      `The audience changed: it is now ${emails.length} people, not ${confirmRecipientCount}. Check it and send again.`
    );
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.broadcast.updateMany({
      where: { id, status: "DRAFT" },
      data: {
        status: "SENDING",
        sendStartedAt: new Date(),
        recipientCount: emails.length,
      },
    });
    if (count === 0)
      throw new ConflictError("This broadcast has already been started.");
    await tx.broadcastRecipient.createMany({
      data: emails.map((email) => ({ broadcastId: id, email })),
      skipDuplicates: true,
    });
  }, BROADCAST_START_TRANSACTION_OPTIONS);
  logger.info(
    { broadcastId: id, recipients: emails.length },
    "[Broadcast] Started"
  );
  return getBroadcast(id);
}

export async function cancelBroadcast(id: string) {
  const { count } = await prisma.broadcast.updateMany({
    where: { id, status: { in: ["DRAFT", "SENDING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.broadcast.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError("Broadcast not found");
    throw new ConflictError(
      "This broadcast has already finished or been cancelled."
    );
  }
  logger.info({ broadcastId: id }, "[Broadcast] Cancelled");
  return getBroadcast(id);
}

// ── Sending ─────────────────────────────────────────────────

type ClaimedRecipient = {
  recipientId: string;
  /** A new key for every claim: a recipient given back and claimed again is a new attempt with a new message. */
  claimKey: string;
  broadcastId: string;
  email: string;
  optedIn: boolean;
  subject: string;
  heading: string;
  message: string;
  buttonText: string | null;
  buttonUrl: string | null;
};

/**
 * Claims the next batch. A broadcast may use the day's budget only after the reserve for reminders: the
 * reserve is held until the reminders really use it, so reminders may take all of it and a broadcast
 * takes the rest. One mail per address per run, and none to an address that got a reminder or a broadcast
 * in the last 24 hours (those stay PENDING and are picked up once the 24 hours pass). Anyone who opted
 * out or withdrew since the snapshot is dropped from the list.
 */
export async function claimBroadcastBatch(
  settings: Awaited<ReturnType<typeof getReminderSettings>>,
  now: Date
): Promise<ClaimedRecipient[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EMAIL_CLAIM_LOCK_KEY}))`;

    const dayStart = istDayStart(now);
    const { reminders: reminderUsed, broadcast: broadcastUsed } =
      await countBudgetUsed(tx, dayStart);
    const slots = Math.min(
      settings.perRunLimit,
      settings.dailyBudget -
        Math.max(settings.reminderReserve, reminderUsed) -
        broadcastUsed
    );
    if (slots <= 0) return [];

    // Addresses mailed in the last 24 hours are left out in the query itself, so they cannot fill the
    // look-ahead and stall the broadcast; they stay PENDING and are picked up once the 24 hours pass.
    const since = new Date(now.getTime() - PER_ADDRESS_WINDOW_MS);
    const [recentReminders, recentBroadcasts] = await Promise.all([
      tx.reminderSend.findMany({
        where: {
          claimedAt: { gt: since },
          status: { in: [...SPENT_STATUSES] },
        },
        select: { email: true },
      }),
      tx.broadcastRecipient.findMany({
        where: {
          claimedAt: { gt: since },
          status: { in: ["CLAIMED", "SENT"] },
        },
        select: { email: true },
      }),
    ]);
    const heldSet = new Set([
      ...recentReminders.map((r) => r.email),
      ...recentBroadcasts.map((r) => r.email),
    ]);

    // Outside production only allow-listed addresses can be mailed; leaving the rest out of the look-ahead
    // keeps them from filling it and stalling the ones that can be.
    const emailFilter: { notIn?: string[]; in?: string[] } = {};
    if (heldSet.size > 0) emailFilter.notIn = [...heldSet];
    const devAllowed = devAllowedRecipients();
    if (devAllowed !== null) emailFilter.in = devAllowed;

    const candidates = await tx.broadcastRecipient.findMany({
      where: {
        status: "PENDING",
        broadcast: { status: "SENDING" },
        ...(Object.keys(emailFilter).length > 0 ? { email: emailFilter } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: slots * CANDIDATE_LOOKAHEAD_FACTOR + CANDIDATE_LOOKAHEAD_EXTRA,
      include: { broadcast: true },
    });
    if (candidates.length === 0) return [];

    const emails = [...new Set(candidates.map((c) => c.email))];
    const [optedOut, users] = await Promise.all([
      tx.emailOptOut.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      }),
      tx.user.findMany({
        // Case-insensitive: the recipient list is lowercase, a stored address may not be.
        where: {
          OR: emails.map((e) => ({
            email: { equals: e, mode: "insensitive" as const },
          })),
        },
        select: {
          id: true,
          email: true,
          emailVerified: true,
          accounts: { select: { providerId: true } },
        },
      }),
    ]);
    const consents = await tx.marketingConsent.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { userId: true, withdrawnAt: true },
    });
    const consentedUserIds = new Set(
      consents.filter((c) => c.withdrawnAt === null).map((c) => c.userId)
    );
    const withdrawnUserIdSet = new Set(
      consents.filter((c) => c.withdrawnAt !== null).map((c) => c.userId)
    );
    const consentedEmailSet = new Set(
      users
        .filter((u) => isTrustedAddressUser(u) && consentedUserIds.has(u.id))
        .map((u) => clean(u.email))
    );
    const withdrawnEmailSet = new Set(
      users
        .filter((u) => withdrawnUserIdSet.has(u.id))
        .map((u) => clean(u.email))
    );
    // A customer with a global opt-out on any other known address (account, session or order) is dropped
    // too (D-122): one read of those addresses, one of the opt-outs among them.
    const known = await knownAddressesByUser(
      tx,
      users.map((u) => u.id)
    );
    const knownAddresses = new Set<string>();
    for (const set of known.values())
      for (const e of set) knownAddresses.add(e);
    const optedOutKnown = new Set(
      (knownAddresses.size === 0
        ? []
        : await tx.emailOptOut.findMany({
            where: { email: { in: [...knownAddresses] } },
            select: { email: true },
          })
      ).map((o) => o.email)
    );
    const silencedEmailSet = new Set(
      users
        .filter((u) =>
          [...(known.get(u.id) ?? [])].some((e) => optedOutKnown.has(e))
        )
        .map((u) => clean(u.email))
    );
    const optedOutSet = new Set(optedOut.map((o) => o.email));

    const dropIds: string[] = [];
    const chosen: ClaimedRecipient[] = [];
    const takenThisRun = new Set<string>();
    for (const c of candidates) {
      const consented = consentedEmailSet.has(c.email);
      // Opted out, unticked the box since the snapshot (either audience), or (for the narrow audience) no
      // longer consenting: dropped for good.
      if (
        optedOutSet.has(c.email) ||
        silencedEmailSet.has(c.email) ||
        withdrawnEmailSet.has(c.email) ||
        (c.broadcast.audience === "OPTED_IN_ONLY" && !consented)
      ) {
        dropIds.push(c.id);
        continue;
      }
      if (chosen.length >= slots) continue;
      if (takenThisRun.has(c.email)) continue;
      takenThisRun.add(c.email);
      chosen.push({
        recipientId: c.id,
        claimKey: randomUUID(),
        broadcastId: c.broadcastId,
        email: c.email,
        optedIn: consented,
        subject: c.broadcast.subject,
        heading: c.broadcast.heading,
        message: c.broadcast.message,
        buttonText: c.broadcast.buttonText,
        buttonUrl: c.broadcast.buttonUrl,
      });
    }

    if (dropIds.length > 0) {
      await tx.broadcastRecipient.deleteMany({
        where: { id: { in: dropIds }, status: "PENDING" },
      });
    }
    if (chosen.length === 0) return [];
    const { count } = await tx.broadcastRecipient.updateMany({
      where: {
        id: { in: chosen.map((c) => c.recipientId) },
        status: "PENDING",
      },
      data: { status: "CLAIMED", claimedAt: now },
    });
    // Under the advisory lock every chosen row is PENDING, so a short count is not expected. Throwing rolls
    // the whole claim back, instead of leaving rows CLAIMED with nothing sent.
    if (count !== chosen.length) {
      throw new Error("[Broadcast] Claim count mismatch: claim rolled back");
    }
    return chosen;
  }, CLAIM_TRANSACTION_OPTIONS);
}

const release = (recipientId: string) =>
  prisma.broadcastRecipient.updateMany({
    where: { id: recipientId, status: "CLAIMED" },
    data: { status: "PENDING", claimedAt: null },
  });

/** One claimed recipient: re-checks the broadcast was not cancelled, then sends. Never throws. */
async function sendClaimedRecipient(
  claim: ClaimedRecipient
): Promise<SendOutcome> {
  // Everything before the send touches only our own database and code: if it fails nothing was sent, so
  // the claim is given back instead of being left as an unknown send result (counted, never retried).
  let prepared: {
    subject: string;
    html: string;
    headers?: Record<string, string>;
  };
  try {
    const current = await prisma.broadcast.findUnique({
      where: { id: claim.broadcastId },
      select: { status: true },
    });
    if (current?.status !== "SENDING") {
      await release(claim.recipientId);
      return "released";
    }

    const unsubscribe = await buildUnsubscribeLinks(
      claim.email,
      "GLOBAL",
      null,
      true
    );
    const email = renderBroadcastEmail({
      subject: claim.subject,
      heading: claim.heading,
      message: claim.message,
      buttonText: claim.buttonText,
      buttonUrl: claim.buttonUrl,
      optedIn: claim.optedIn,
      stopUrl: unsubscribe.stopUrl,
    });
    prepared = { ...email, headers: unsubscribe.headers };
  } catch (err) {
    logger.error(
      { err },
      "[Broadcast] Could not prepare a message: claim released, nothing sent"
    );
    await release(claim.recipientId).catch((releaseErr) =>
      logger.error(
        { err: releaseErr },
        "[Broadcast] Could not release the claim either: it stays claimed"
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
        idempotencyKey: claim.claimKey,
        ...(prepared.headers ? { headers: prepared.headers } : {}),
      })
    );
    await prisma.broadcastRecipient.updateMany({
      where: { id: claim.recipientId, status: "CLAIMED" },
      data: {
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: result.messageId,
      },
    });
    return "sent";
  } catch (err) {
    if (err instanceof EmailGuardRefusal) {
      // Only outside production: this address may not be mailed from here. Marked, so it does not block
      // the addresses behind it on every run.
      await prisma.broadcastRecipient.updateMany({
        where: { id: claim.recipientId, status: "CLAIMED" },
        data: { status: "FAILED", errorName: DEV_GUARD_ERROR_NAME },
      });
      return "failed";
    }
    if (err instanceof EmailSendError) {
      const failure = classifyResendError(err);
      if (failure === "limited" || failure === "config") {
        // Nothing was sent: give the claim back and stop the run.
        await release(claim.recipientId);
        logger[failure === "config" ? "error" : "warn"](
          { provider: err.providerName, status: err.providerStatus },
          failure === "config"
            ? "[Broadcast] Resend rejected the account setup (key or domain): run stopped"
            : "[Broadcast] Resend is limiting this account: run stopped"
        );
        return "limited";
      }
      if (failure === "refused") {
        await prisma.broadcastRecipient.updateMany({
          where: { id: claim.recipientId, status: "CLAIMED" },
          data: { status: "FAILED", errorName: capErrorName(err.providerName) },
        });
        logger.error(
          { provider: err.providerName, status: err.providerStatus },
          "[Broadcast] Resend refused a recipient"
        );
        return "failed";
      }
    }
    // Result unknown: stays CLAIMED (counted, never resent); after an hour it no longer holds the broadcast open.
    logger.error({ err }, "[Broadcast] Send result unknown, claim left as is");
    return "unknown";
  }
}

/** Keeps the counts of every sending broadcast current and closes the ones with nothing left to do. */
export async function finalizeBroadcasts(now: Date): Promise<void> {
  const sending = await prisma.broadcast.findMany({
    where: { status: "SENDING" },
    select: { id: true, sendStartedAt: true },
  });
  for (const b of sending) {
    if (
      b.sendStartedAt &&
      b.sendStartedAt <
        new Date(now.getTime() - BROADCAST_AUTO_CANCEL_DAYS * DAY_MS)
    ) {
      await prisma.broadcast.updateMany({
        where: { id: b.id, status: "SENDING" },
        data: { status: "CANCELLED", finishedAt: now },
      });
      logger.warn(
        { broadcastId: b.id },
        "[Broadcast] Auto-cancelled after the time limit"
      );
      continue;
    }
    const [sent, failed, pending, freshClaimed] = await Promise.all([
      prisma.broadcastRecipient.count({
        where: { broadcastId: b.id, status: "SENT" },
      }),
      prisma.broadcastRecipient.count({
        where: { broadcastId: b.id, status: "FAILED" },
      }),
      prisma.broadcastRecipient.count({
        where: { broadcastId: b.id, status: "PENDING" },
      }),
      prisma.broadcastRecipient.count({
        where: {
          broadcastId: b.id,
          status: "CLAIMED",
          claimedAt: { gt: new Date(now.getTime() - CLAIM_LOST_AFTER_MS) },
        },
      }),
    ]);
    const done = pending === 0 && freshClaimed === 0;
    await prisma.broadcast.updateMany({
      where: { id: b.id, status: "SENDING" },
      data: {
        sentCount: sent,
        failedCount: failed,
        ...(done ? { status: "SENT" as const, finishedAt: now } : {}),
      },
    });
  }
}

/** One run for the sweep. Returns how many were sent. Counts and housekeeping always run; sending needs the window. */
export async function sweepBroadcasts(
  now: Date = new Date(),
  runBudgetMs: number = REMINDER_RUN_BUDGET_MS
): Promise<number> {
  const startedAt = Date.now();
  await finalizeBroadcasts(now);

  const settings = await getReminderSettings();
  if (
    !isInsideSendWindow(now, settings.windowStartHour, settings.windowEndHour)
  )
    return 0;
  if ((await prisma.broadcast.count({ where: { status: "SENDING" } })) === 0)
    return 0;

  const claims = await claimBroadcastBatch(settings, now);
  let sent = 0;
  let attempted = 0;
  let troubleInARow = 0;
  for (const claim of claims) {
    if (Date.now() - startedAt > runBudgetMs) break;
    attempted += 1;
    const outcome = await sendClaimedRecipient(claim);
    if (outcome === "sent") sent += 1;
    if (outcome === "limited") break;
    troubleInARow = isTrouble(outcome) ? troubleInARow + 1 : 0;
    if (troubleInARow >= MAX_CONSECUTIVE_TROUBLE) {
      logger.error(
        "[Broadcast] Several sends in a row went wrong (no answer, a refusal or a failed preparation): run stopped"
      );
      break;
    }
  }
  // Claims this run never tried were never sent: give them back.
  for (const claim of claims.slice(attempted)) await release(claim.recipientId);

  await finalizeBroadcasts(now);
  if (claims.length > 0)
    logger.info({ claimed: claims.length, sent }, "[Broadcast] Run finished");
  return sent;
}
