import { randomBytes } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { MARKETING_CONSENT_WORDING_VERSION } from "../config/reminders.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

// ============================================================
// UNSUBSCRIBE AND MARKETING CONSENT (feature 5)
// ============================================================
//
// Two ways a person controls our bulk emails:
//   - the link in the email footer (a random token, no address in any URL), which either stops all
//     promotions and reminders to buy or review (GLOBAL), or stops reminder B for one order only;
//   - the unticked "send me offers and news" box at checkout, stored as a consent that the person can
//     withdraw. The newer of the two actions wins.
// Neither ever touches the six order emails.

/** A token is 24 random bytes in base64url (32 characters). Anything else cannot be one of ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

type UnsubscribeInfo = {
  found: boolean;
  scope: "GLOBAL" | "ORDER_REMINDER" | null;
};

async function findToken(token: string) {
  if (!TOKEN_SHAPE.test(token)) return null;
  return prisma.emailUnsubscribeToken.findUnique({ where: { token } });
}

/** What the page shows before the button. Changes nothing, so a mail scanner opening the link does no harm. */
export async function getUnsubscribeInfo(
  token: string
): Promise<UnsubscribeInfo> {
  const row = await findToken(token);
  return row
    ? { found: true, scope: row.scope }
    : { found: false, scope: null };
}

/**
 * Does what the token's link promises. Safe to repeat. An unknown or expired token is a 404 with an honest
 * message, never a pretend "done".
 */
export async function applyUnsubscribe(
  token: string
): Promise<{ scope: "GLOBAL" | "ORDER_REMINDER" }> {
  const row = await findToken(token);
  if (!row) throw new NotFoundError("This link has expired or is not valid.");

  if (row.scope === "ORDER_REMINDER") {
    if (row.orderSessionId) {
      await prisma.reminderStop.upsert({
        where: {
          kind_orderSessionId: {
            kind: "BOOK_NOT_SENT",
            orderSessionId: row.orderSessionId,
          },
        },
        create: { kind: "BOOK_NOT_SENT", orderSessionId: row.orderSessionId },
        update: {},
      });
    }
    logger.info(
      { scope: "ORDER_REMINDER" },
      "[Unsubscribe] Reminders stopped for one order"
    );
    return { scope: "ORDER_REMINDER" };
  }

  await prisma.emailOptOut.upsert({
    where: { email: row.email },
    create: { email: row.email },
    update: {},
  });
  // Someone who unsubscribes has also withdrawn the checkout consent: the box must not read "ticked".
  const users = await prisma.user.findMany({
    where: { email: { equals: row.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (users.length > 0) {
    await prisma.marketingConsent.updateMany({
      where: { userId: { in: users.map((u) => u.id) }, withdrawnAt: null },
      data: { withdrawnAt: new Date() },
    });
  }
  logger.info({ scope: "GLOBAL" }, "[Unsubscribe] Address opted out");
  return { scope: "GLOBAL" };
}

// -- Whose address can be trusted ----------------------------

/** Sign-in providers that hand us the person's own, provider-confirmed address. */
const SOCIAL_PROVIDERS = ["google", "facebook"];

/**
 * Users whose address is theirs: a verified address, or a sign-in through a social provider (which confirms
 * the address itself). Sign-up with email and password does not verify the address, so anyone can hold such
 * an account under someone else's address; those are not trusted.
 */
export const TRUSTED_ADDRESS_USER = {
  OR: [
    { emailVerified: true },
    { accounts: { some: { providerId: { in: SOCIAL_PROVIDERS } } } },
  ],
} satisfies Prisma.UserWhereInput;

/** The same rule for a user already loaded with `emailVerified` and `accounts.providerId`. */
export const isTrustedAddressUser = (u: {
  emailVerified: boolean;
  accounts: { providerId: string }[];
}): boolean =>
  u.emailVerified ||
  u.accounts.some((a) => SOCIAL_PROVIDERS.includes(a.providerId));

async function hasTrustedAddress(userId: string): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, ...TRUSTED_ADDRESS_USER },
    select: { id: true },
  });
  return user !== null;
}

// -- The checkout box ----------------------------------------

export async function getMarketingConsent(
  userId: string
): Promise<{ optedIn: boolean; canTick: boolean }> {
  const [row, canTick] = await Promise.all([
    prisma.marketingConsent.findUnique({
      where: { userId },
      select: { withdrawnAt: true },
    }),
    hasTrustedAddress(userId),
  ]);
  return { optedIn: row !== null && row.withdrawnAt === null, canTick };
}

/**
 * Ticks or unticks the box for the signed-in user. The user id and address come from the session, never
 * from the request. Ticking again after an unsubscribe clears that opt-out (the person's newer action
 * wins); unticking records the withdrawal and keeps the row as evidence.
 *
 * Anyone can create an account with an address that is not theirs (sign-up does not require a verified
 * address), so only an account with a trusted address (verified, or a social sign-in) can tick: any other is refused, so nobody is shown
 * a tick that does nothing and nobody's unsubscribe is cleared by someone else's account.
 */
export async function setMarketingConsent(
  user: { id: string; email: string },
  optedIn: boolean
): Promise<{ optedIn: boolean }> {
  const email = user.email.trim().toLowerCase();
  const now = new Date();
  if (optedIn) {
    // Only a trusted address may tick (see above).
    if (!(await hasTrustedAddress(user.id))) {
      throw new ForbiddenError(
        "Please verify your email address before choosing to receive offers."
      );
    }
    await prisma.marketingConsent.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        email,
        optedInAt: now,
        wordingVersion: MARKETING_CONSENT_WORDING_VERSION,
        source: "checkout",
      },
      update: {
        email,
        optedInAt: now,
        withdrawnAt: null,
        wordingVersion: MARKETING_CONSENT_WORDING_VERSION,
        source: "checkout",
      },
    });
    await prisma.emailOptOut.deleteMany({ where: { email } });
  } else {
    await prisma.marketingConsent.updateMany({
      where: { userId: user.id, withdrawnAt: null },
      data: { withdrawnAt: now },
    });
  }
  return { optedIn };
}

// -- The link in every bulk email ----------------------------

/** A random, unguessable token for an unsubscribe link (24 bytes). The address never appears in a URL. */
async function createUnsubscribeToken(
  email: string,
  scope: "GLOBAL" | "ORDER_REMINDER",
  orderSessionId: string | null
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await prisma.emailUnsubscribeToken.create({
    data: { token, email, scope, orderSessionId },
  });
  return token;
}

/**
 * A fresh token and the two places it appears: the footer link (the page the customer opens) and, for
 * marketing mail, the one-click header a mail app uses (a POST to the API, answered by applyUnsubscribe).
 * ⚠️ The footer page is the frontend's /unsubscribe (app/unsubscribe/page.tsx), which reads the token from
 * the `t` query parameter; the API path is routes/public.ts. Change them together.
 * Reminder B passes `oneClick: false`: it is about a paid order, so it carries no one-click header.
 */
export async function buildUnsubscribeLinks(
  email: string,
  scope: "GLOBAL" | "ORDER_REMINDER",
  orderSessionId: string | null,
  oneClick: boolean
): Promise<{ stopUrl: string; headers?: Record<string, string> }> {
  const token = await createUnsubscribeToken(email, scope, orderSessionId);
  const stopUrl = `${config.frontendUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
  if (!oneClick) return { stopUrl };
  const api = config.betterAuthUrl.replace(/\/+$/, "");
  return {
    stopUrl,
    headers: {
      "List-Unsubscribe": `<${api}/api/public/email/unsubscribe/${encodeURIComponent(token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
