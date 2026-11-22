import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type { OrderSessionStatus } from "../generated/prisma/client.js";
import { NotFoundError } from "../utils/errors.js";
import { publicUrlToKey } from "../utils/deletionKeys.js";
import { SHARE_NAME_MAX_CHARS, SHARE_TOKEN_SHAPE } from "../config/share.js";
import { EXPIRY_EXEMPT_STATUSES } from "./session.service.js";

// The view-only share link of a customer's book (feature 14). Plan: docs/phase2/features/09-sharing/PLAN.md.
//
// The token in the link is NOT the session id: the session id is the customer's private link and is never in a
// share response, page url or image url. Every read below selects an explicit list of fields (never the whole
// session) and answers the same "not found" for an unknown, revoked, expired or deleted share.

export const SHARE_NOT_FOUND_MESSAGE = "This shared book is not available.";

export const isShareToken = (token: unknown): token is string =>
  typeof token === "string" && SHARE_TOKEN_SHAPE.test(token);

export interface ShareSessionFacts {
  status: OrderSessionStatus;
  expiresAt: Date;
  isSample: boolean;
  photoDeletedAt: Date | null;
  filesDeletedAt: Date | null;
  order: { status: string } | null;
}

/** An unpaid session has no order, or an order that is still only created (the same rule as getOrderSessionId). */
const isUnpaid = (session: Pick<ShareSessionFacts, "order">): boolean =>
  !session.order || session.order.status === "CREATED";

/**
 * True when the book can no longer be shared: a sample, deleted files, a deleted photo of an unpaid preview, or an
 * expired unpaid preview. Same expiry and "unpaid" rules as getOrderSessionId, except that deleted files end the
 * share in every state and samples are never shared. An expiry equal to `now` is still alive.
 */
export function isSessionGone(session: ShareSessionFacts, now: Date): boolean {
  if (session.isSample) return true;
  if (session.filesDeletedAt) return true;
  if (session.photoDeletedAt && isUnpaid(session)) return true;
  return (
    session.expiresAt < now && !EXPIRY_EXEMPT_STATUSES.includes(session.status)
  );
}

/** The variant a share shows: the printed (selected) one, else the highest. The caller passes ready variants only. */
export function pickShareVariant<
  T extends { isSelected: boolean; variantIndex: number },
>(variants: T[]): T | null {
  if (variants.length === 0) return null;
  const selected = variants.find((v) => v.isSelected);
  if (selected) return selected;
  return variants.reduce((best, v) =>
    v.variantIndex > best.variantIndex ? v : best
  );
}

/**
 * The storage key of a share image, or null when the stored url is not exactly one of this session's web images.
 * The url must be one of ours, and the key must be `sessions/<this session>/final/<file>.webp`.
 */
export function sharedImageKey(sessionId: string, url: string): string | null {
  const key = publicUrlToKey(url);
  if (!key || key.includes("..")) return null;
  const prefix = `sessions/${sessionId}/final/`;
  if (!key.startsWith(prefix)) return null;
  return /^[A-Za-z0-9._-]+\.webp$/.test(key.slice(prefix.length)) ? key : null;
}

/** The first word of a name, at most SHARE_NAME_MAX_CHARS characters: all the share ever sends of a child's name. */
export function firstWord(name: string | null | undefined): string {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return Array.from(word).slice(0, SHARE_NAME_MAX_CHARS).join("");
}

const newToken = () => randomBytes(24).toString("base64url");

const sessionFactsSelect = {
  id: true,
  status: true,
  expiresAt: true,
  isSample: true,
  photoDeletedAt: true,
  filesDeletedAt: true,
  order: { select: { status: true } },
} as const;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

// -- The customer's side (session id) ------------------------

export interface ShareState {
  available: boolean;
  active: boolean;
  token: string | null;
  showName: boolean;
}

async function loadSessionFacts(sessionId: string) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    select: sessionFactsSelect,
  });
  if (!session) throw new NotFoundError("Session not found");
  return session;
}

/** What the preview page needs to draw its Share button. A sample or a gone book is simply not available. */
export async function getShareState(
  sessionId: string,
  now = new Date()
): Promise<ShareState> {
  const session = await loadSessionFacts(sessionId);
  if (isSessionGone(session, now))
    return { available: false, active: false, token: null, showName: false };
  const share = await prisma.sessionShare.findUnique({
    where: { orderSessionId: sessionId },
  });
  const active = !!share && !share.revokedAt;
  return {
    available: true,
    active,
    token: active ? share.token : null,
    showName: active ? share.showName : false,
  };
}

/**
 * Creates the session's share link, or returns the live one. A revoked share gets a new token (the old link
 * stays dead). `showName` is left alone when not given; a new or rotated share starts with it off.
 */
export async function createOrGetShare(
  sessionId: string,
  showName: boolean | undefined,
  now = new Date()
): Promise<{ token: string; showName: boolean }> {
  const session = await loadSessionFacts(sessionId);
  if (isSessionGone(session, now)) throw new NotFoundError("Session not found");

  let share = await prisma.sessionShare.findUnique({
    where: { orderSessionId: sessionId },
  });
  if (!share) {
    try {
      share = await prisma.sessionShare.create({
        data: {
          orderSessionId: sessionId,
          token: newToken(),
          showName: showName ?? false,
        },
      });
    } catch (error) {
      // Two creates at once: the other one won. Read its row.
      if (!isUniqueViolation(error)) throw error;
      share = await prisma.sessionShare.findUnique({
        where: { orderSessionId: sessionId },
      });
    }
  } else if (share.revokedAt) {
    // Only one of several concurrent callers rotates; the others read the same new token.
    await prisma.sessionShare.updateMany({
      where: { id: share.id, revokedAt: { not: null } },
      data: { token: newToken(), revokedAt: null, showName: showName ?? false },
    });
    share = await prisma.sessionShare.findUnique({
      where: { orderSessionId: sessionId },
    });
  } else if (showName !== undefined && showName !== share.showName) {
    // Guarded: a share stopped in the meantime is not changed here (the re-read shows it as stopped).
    await prisma.sessionShare.updateMany({
      where: { id: share.id, revokedAt: null },
      data: { showName },
    });
    share = await prisma.sessionShare.findUnique({
      where: { orderSessionId: sessionId },
    });
  }
  if (!share) throw new NotFoundError("Session not found");
  return { token: share.token, showName: share.showName };
}

/**
 * Changes only the name flag of a LIVE share. A stopped share is never brought back by this (the customer's dialog may
 * be stale): it answers not found, and the page shows the real state.
 */
export async function updateShareName(
  sessionId: string,
  showName: boolean,
  now = new Date()
): Promise<{ token: string; showName: boolean }> {
  const session = await loadSessionFacts(sessionId);
  if (isSessionGone(session, now)) throw new NotFoundError("Session not found");
  const result = await prisma.sessionShare.updateMany({
    where: { orderSessionId: sessionId, revokedAt: null },
    data: { showName },
  });
  if (result.count === 0) throw new NotFoundError("Sharing is not active");
  const share = await prisma.sessionShare.findUnique({
    where: { orderSessionId: sessionId },
  });
  if (!share || share.revokedAt)
    throw new NotFoundError("Sharing is not active");
  return { token: share.token, showName: share.showName };
}

/** Stops sharing. Safe to repeat; a gone book has nothing live to stop. */
export async function revokeShare(sessionId: string): Promise<void> {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    select: { id: true, isSample: true },
  });
  if (!session || session.isSample)
    throw new NotFoundError("Session not found");
  await prisma.sessionShare.updateMany({
    where: { orderSessionId: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// -- The viewer's side (share token) ------------------------

const shareViewSelect = (pageNumber?: number) =>
  ({
    revokedAt: true,
    showName: true,
    orderSession: {
      select: {
        ...sessionFactsSelect,
        childName: true,
        comic: { select: { id: true, title: true } },
        sessionPages: {
          where: pageNumber === undefined ? {} : { page: { pageNumber } },
          select: {
            isPreviewPage: true,
            page: { select: { pageNumber: true } },
          },
        },
        pageVersions: {
          where: {
            status: "SD_READY" as const,
            displayImageUrl: { not: null },
            ...(pageNumber === undefined ? {} : { page: { pageNumber } }),
          },
          select: {
            isSelected: true,
            variantIndex: true,
            displayImageUrl: true,
            page: { select: { pageNumber: true } },
          },
        },
      },
    },
  }) satisfies Prisma.SessionShareSelect;

/** The share and its session, only while it is live. One answer for every dead case. */
async function loadLiveShare(
  token: string,
  pageNumber: number | undefined,
  now: Date
) {
  if (!isShareToken(token)) return null;
  const share = await prisma.sessionShare.findUnique({
    where: { token },
    select: shareViewSelect(pageNumber),
  });
  if (!share || share.revokedAt) return null;
  if (isSessionGone(share.orderSession, now)) return null;
  return share;
}

export interface SharedBook {
  comic: { id: string; title: string };
  childName?: string;
  pages: { pageNumber: number }[];
  lockedCount: number;
  ready: boolean;
  complete: boolean;
}

type LiveShareSession = NonNullable<
  Awaited<ReturnType<typeof loadLiveShare>>
>["orderSession"];

/** The pages of a live share's book that can be shown, as [pageNumber, variant] pairs in page order. */
function listablePages(session: LiveShareSession) {
  const unpaid = isUnpaid(session);
  const byPage = new Map<number, typeof session.pageVersions>();
  for (const version of session.pageVersions) {
    // Only a variant whose image the image route can serve counts: the list and the route must agree.
    if (
      !version.displayImageUrl ||
      !sharedImageKey(session.id, version.displayImageUrl)
    )
      continue;
    const list = byPage.get(version.page.pageNumber) ?? [];
    list.push(version);
    byPage.set(version.page.pageNumber, list);
  }
  const pages: {
    pageNumber: number;
    variant: (typeof session.pageVersions)[number];
  }[] = [];
  let lockedCount = 0;
  for (const sessionPage of session.sessionPages) {
    if (unpaid && !sessionPage.isPreviewPage) {
      lockedCount += 1;
      continue;
    }
    const variant = pickShareVariant(
      byPage.get(sessionPage.page.pageNumber) ?? []
    );
    if (variant)
      pages.push({ pageNumber: sessionPage.page.pageNumber, variant });
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  return { pages, lockedCount, total: session.sessionPages.length };
}

export async function getSharedBook(
  token: string,
  now = new Date()
): Promise<SharedBook> {
  const share = await loadLiveShare(token, undefined, now);
  if (!share) throw new NotFoundError(SHARE_NOT_FOUND_MESSAGE);
  const { pages, lockedCount, total } = listablePages(share.orderSession);
  const book: SharedBook = {
    comic: {
      id: share.orderSession.comic.id,
      title: share.orderSession.comic.title,
    },
    pages: pages.map((p) => ({ pageNumber: p.pageNumber })),
    lockedCount,
    ready: pages.length > 0,
    complete: pages.length + lockedCount === total,
  };
  const first = share.showName ? firstWord(share.orderSession.childName) : "";
  if (first) book.childName = first;
  return book;
}

/** The storage key of one page of a live share, or null when that page is not shown (the one not-found). */
export async function resolveSharedImageKey(
  token: string,
  pageNumber: number,
  now = new Date()
): Promise<string | null> {
  const share = await loadLiveShare(token, pageNumber, now);
  if (!share) return null;
  const { pages } = listablePages(share.orderSession);
  const page = pages.find((p) => p.pageNumber === pageNumber);
  if (!page?.variant.displayImageUrl) return null;
  return sharedImageKey(share.orderSession.id, page.variant.displayImageUrl);
}
