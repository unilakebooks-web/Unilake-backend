import type { Request, Response } from "express";
import sharp from "sharp";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { NotFoundError } from "../utils/errors.js";
import { ByteBudget, type Release } from "../utils/byteBudget.js";
import { logger } from "../lib/logger.js";
import {
  headObjectChecked,
  openObjectChecked,
  StorageObjectRefusedError,
  type OpenedObject,
} from "../lib/r2.js";
import {
  createOrGetShare,
  getShareState,
  getSharedBook,
  isShareToken,
  resolveSharedImageKey,
  SHARE_NOT_FOUND_MESSAGE,
  revokeShare,
} from "../services/share.service.js";
import {
  SHARE_BYTE_BUDGET,
  SHARE_CARD_CACHE_ENTRIES,
  SHARE_CARD_CONCURRENCY,
  SHARE_CARD_MAX_BYTES,
  SHARE_CARD_QUALITIES,
  SHARE_CARD_WIDTH,
  SHARE_FIRST_BYTE_TIMEOUT_MS,
  SHARE_IMAGE_MAX_AGE_SECONDS,
  SHARE_MAX_OBJECT_BYTES,
  SHARE_READ_DEADLINE_MS,
  SHARE_RETRY_AFTER_SECONDS,
  SHARE_WAIT_MS,
  SHARE_WRITE_DEADLINE_MS,
} from "../config/share.js";

// Share routes (feature 14). The routes keyed by a share token answer their own errors instead of passing them to
// the global handler, which logs the request url: that url holds the token (and a storage key holds the private
// session id), so neither may reach the logs.

/** The token or the session id is the only thing in these urls; keep the answers out of caches and Referer headers. */
function noTrace(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ── The customer's side: the session id is the credential, as on every other session route ──

export const getShareStateHandler = asyncHandler(
  async (req: Request, res: Response) => {
    noTrace(res);
    sendSuccess(res, 200, await getShareState(req.params.sessionId as string));
  }
);

export const createShareHandler = asyncHandler(
  async (req: Request, res: Response) => {
    noTrace(res);
    sendSuccess(
      res,
      200,
      await createOrGetShare(req.params.sessionId as string, req.body?.showName)
    );
  }
);

export const revokeShareHandler = asyncHandler(
  async (req: Request, res: Response) => {
    noTrace(res);
    await revokeShare(req.params.sessionId as string);
    res.status(204).end();
  }
);

// ── The viewer's side: the share token is the credential ──

const notFoundBody = {
  success: false,
  error: { code: "NOT_FOUND", message: SHARE_NOT_FOUND_MESSAGE },
};

function answerNotFound(res: Response) {
  noTrace(res);
  res.status(404).json(notFoundBody);
}

function answerFailure(res: Response, error: unknown) {
  // Only the error's name is logged: its message can hold a storage key.
  logger.error({ errorName: (error as Error)?.name }, "Share request failed");
  if (res.headersSent) {
    res.destroy();
    return;
  }
  noTrace(res);
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred on the server.",
    },
  });
}

export const getSharedBookHandler = async (req: Request, res: Response) => {
  try {
    const book = await getSharedBook(req.params.token as string);
    noTrace(res);
    sendSuccess(res, 200, book);
  } catch (error) {
    if (error instanceof NotFoundError) return answerNotFound(res);
    answerFailure(res, error);
  }
};

const memory = new ByteBudget(SHARE_BYTE_BUDGET);
// At most this many card conversions at once (a budget of one unit each), so a burst of previews cannot take the CPU.
const cardSlots = new ByteBudget(SHARE_CARD_CONCURRENCY);
const cardCache = new Map<string, Buffer>();

const PAGE_NUMBER_SHAPE = /^[1-9][0-9]{0,3}$/;

/** On every image answer, errors included: a cross-origin page may embed it, and no search engine may index it. */
function setBaseImageHeaders(res: Response) {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Robots-Tag", "noindex");
}

function setImageHeaders(
  res: Response,
  etag: string | undefined,
  contentType: string
) {
  setBaseImageHeaders(res);
  res.setHeader(
    "Cache-Control",
    `public, max-age=${SHARE_IMAGE_MAX_AGE_SECONDS}`
  );
  res.setHeader("Content-Type", contentType);
  if (etag) res.setHeader("ETag", etag);
}

function answerImageError(res: Response, status: number) {
  setBaseImageHeaders(res);
  res.setHeader("Cache-Control", "no-store");
  res.status(status).end();
}

/** The card has its own ETag, so a change of the conversion cannot be answered 304 with the webp's tag. */
const cardEtag = (etag: string | undefined) =>
  etag ? etag.replace(/"$/, '-card"') : undefined;

export async function toCardJpeg(source: Buffer): Promise<Buffer> {
  let output = Buffer.alloc(0);
  for (const quality of SHARE_CARD_QUALITIES) {
    output = await sharp(source)
      .resize({ width: SHARE_CARD_WIDTH, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality })
      .toBuffer();
    if (output.length <= SHARE_CARD_MAX_BYTES) return output;
  }
  logger.warn(
    { bytes: output.length },
    "Share card is over the size target at the lowest quality"
  );
  return output;
}

/** Reserves `bytes` of the byte budget for this response, or answers 503. Returns null when it answered (or the client left). */
async function reserveOrAnswer(
  res: Response,
  bytes: number,
  gone: AbortSignal
): Promise<Release | null> {
  const release = await memory.acquire(bytes, SHARE_WAIT_MS, gone);
  if (!release) {
    if (!gone.aborted) {
      res.setHeader("Retry-After", String(SHARE_RETRY_AFTER_SECONDS));
      answerImageError(res, 503);
    }
    return null;
  }
  // The close handler is registered after the wait, so a client that left in between never fires it.
  if (res.destroyed) {
    release();
    return null;
  }
  res.once("close", release);
  return release;
}

/** The card JPEG of a page: from the converted opened webp. `retryLater` is true (and `body` is the unconverted source) when no conversion slot came free. */
async function cardBody(
  opened: OpenedObject,
  cacheKey: string,
  gone: AbortSignal
): Promise<{ body: Buffer; retryLater: boolean }> {
  const source = await opened.read();
  const slot = await cardSlots.acquire(1, SHARE_WAIT_MS, gone);
  if (!slot) return { body: source, retryLater: true };
  try {
    const body = await toCardJpeg(source);
    cardCache.set(cacheKey, body);
    // Oldest entry out (insertion order, not least-recently-used).
    if (cardCache.size > SHARE_CARD_CACHE_ENTRIES)
      cardCache.delete(cardCache.keys().next().value as string);
    return { body, retryLater: false };
  } finally {
    slot();
  }
}

function serveImage(kind: "image" | "card") {
  return async (req: Request, res: Response) => {
    let opened: OpenedObject | null = null;
    try {
      const token = req.params.token as string;
      if (!isShareToken(token)) return answerNotFound(res);
      const pageNumberText = req.params.pageNumber as string;
      if (!PAGE_NUMBER_SHAPE.test(pageNumberText))
        return answerImageError(res, 400);

      const key = await resolveSharedImageKey(token, Number(pageNumberText));
      if (!key) return answerImageError(res, 404);

      const contentType = kind === "card" ? "image/jpeg" : "image/webp";

      if (req.method === "HEAD") {
        const head = await headObjectChecked(key, SHARE_FIRST_BYTE_TIMEOUT_MS);
        if (!head) return answerImageError(res, 404);
        setImageHeaders(
          res,
          kind === "card" ? cardEtag(head.etag) : head.etag,
          contentType
        );
        res.status(200).end();
        return;
      }

      opened = await openObjectChecked(key, {
        maxBytes: SHARE_MAX_OBJECT_BYTES,
        firstByteTimeoutMs: SHARE_FIRST_BYTE_TIMEOUT_MS,
        readDeadlineMs: SHARE_READ_DEADLINE_MS,
      });
      if (!opened) return answerImageError(res, 404);

      setImageHeaders(
        res,
        kind === "card" ? cardEtag(opened.etag) : opened.etag,
        contentType
      );
      if (req.fresh) {
        res.status(304).end();
        return;
      }

      // The client leaving ends the wait for memory. The object's ETag came with its headers, so a card that is
      // already converted is answered without reading the object and reserves only the size of the card.
      const gone = new AbortController();
      res.once("close", () => gone.abort());
      const cacheKey = `${token}:${opened.etag}`;
      const cached = kind === "card" ? cardCache.get(cacheKey) : undefined;

      let body: Buffer;
      if (cached) {
        opened.discard();
        if (!(await reserveOrAnswer(res, cached.length, gone.signal))) return;
        body = cached;
      } else {
        if (!(await reserveOrAnswer(res, opened.contentLength, gone.signal)))
          return;
        if (kind === "card") {
          const card = await cardBody(opened, cacheKey, gone.signal);
          if (card.retryLater) {
            res.setHeader("Retry-After", String(SHARE_RETRY_AFTER_SECONDS));
            return answerImageError(res, 503);
          }
          body = card.body;
        } else {
          body = await opened.read();
        }
      }

      res.setHeader("Content-Length", String(body.length));
      const deadline = setTimeout(() => res.destroy(), SHARE_WRITE_DEADLINE_MS);
      res.once("close", () => clearTimeout(deadline));
      res.status(200).end(body);
    } catch (error) {
      if (error instanceof StorageObjectRefusedError) {
        logger.warn("Share image refused");
        return answerImageError(res, 404);
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      logger.error({ errorName: (error as Error)?.name }, "Share image failed");
      answerImageError(res, 500);
    } finally {
      // Nothing may keep the storage connection open, whichever way this ended (harmless after a full read).
      opened?.discard();
    }
  };
}

export const getSharedImageHandler = serveImage("image");
export const getSharedCardHandler = serveImage("card");
