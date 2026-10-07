import { getRoom } from "./rooms.js";
import { logger } from "../lib/logger.js";

export function emitPageReady(
  sessionId: string,
  payload: {
    pageNumber: number;
    variantIndex: number;
    /** Print-resolution PNG. Multi-megabyte — do not render this in a browser. */
    imageUrl: string;
    /**
     * Web-sized WebP derivative — this is what a client should display.
     * Null when the derivative could not be built, in which case fall back
     * to `imageUrl`.
     */
    displayImageUrl: string | null;
    pageVersionId: string;
  }
) {
  const sockets = getRoom(sessionId);

  if (!sockets) {
    logger.debug(
      { sessionId },
      "EmitPageReady : No sockets is connected, skipping"
    );
    return;
  }

  const message = JSON.stringify({ type: "page:ready", ...payload });

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

export function emitPageError(
  sessionId: string,
  payload: {
    pageNumber: number;
    variantIndex: number;
    errorMessage: string;
    /**
     * False means BullMQ still has retries left for this page — the row is NOT
     * terminal and the client must keep showing "generating". Only `true` means
     * every attempt is spent and the page has genuinely given up.
     *
     * Emitted on every attempt rather than only the last so the non-final ones
     * stay available for debugging; the flag is what carries the meaning.
     */
    isFinal: boolean;
  }
) {
  const sockets = getRoom(sessionId);

  if (!sockets) {
    logger.debug({ sessionId }, "emitPageError: no sockets connected, skipping");
    return;
  }

  const message = JSON.stringify({ type: "page:error", ...payload });

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

export function emitSessionPreviewReady(sessionId: string) {
  const sockets = getRoom(sessionId);

  if (!sockets) {
    logger.debug(
      { sessionId },
      "emitSessionPreviewReady: no sockets connected, skipping",
    );
    return;
  }

  const message = JSON.stringify({ type: "session:preview-ready" });

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

export function emitSessionPaidReady(sessionId: string) {
  const sockets = getRoom(sessionId);

  if (!sockets) {
    logger.debug(
      { sessionId },
      "emitSessionPaidReady: no sockets connected, skipping",
    );
    return;
  }

  const message = JSON.stringify({ type: "session:paid-ready" });

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}