import { downloadFileToBuffer } from "../../../lib/r2.js";
import { logger } from "../../../lib/logger.js";

// In-memory cache for the child photo bytes during a burst of concurrent
// worker jobs for the same session. Purely an optimization — avoids
// re-downloading the same 1-5MB photo from R2 five times when concurrency is 5.
//
// Lifecycle:
//   - acquirePhoto() at start of each job. First caller triggers R2 download;
//     subsequent callers await the same Promise. refCount tracks who is using it.
//   - releasePhoto() at end of each job (success OR failure). Decrements refCount;
//     evicts entry when it hits zero.
//   - Timer-based sweep evicts entries idle for CACHE_TTL_MS as a safety net
//     against leaked entries (e.g. worker crashed without releasing).

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min idle before force-evict
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

type CacheEntry = {
  bufferPromise: Promise<Buffer>;
  refCount: number;
  lastAccessedAt: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Get the child photo for a session. First caller triggers the R2 download;
 * subsequent concurrent callers reuse the same in-flight Promise.
 *
 * MUST be paired with releasePhoto() in a finally block by the caller.
 */

export async function acquirePhoto(
  sessionId: string,
  photoKey: string
): Promise<Buffer> {
  const existing = cache.get(sessionId);

  if (existing) {
    existing.refCount++;
    existing.lastAccessedAt = Date.now();
    logger.debug({ sessionId, refCount: existing.refCount }, "photoCache: hit");
    return existing.bufferPromise;
  }

  logger.debug({ sessionId, photoKey }, "photoCache: miss, downloading");

  // Start the download immediately and store the PROMISE (not the awaited value)
  // so any concurrent acquirePhoto() call for the same session gets the same
  // in-flight download.
  const bufferPromise = downloadFileToBuffer("private", photoKey);

  const entry: CacheEntry = {
    bufferPromise,
    refCount: 1,
    lastAccessedAt: Date.now(),
  };
  cache.set(sessionId, entry);

  // If the download itself fails, evict immediately — a broken Promise sitting
  // in the cache would poison every future retry for this session.
  bufferPromise.catch((err) => {
    logger.warn(
      { sessionId, err },
      "photoCache: download failed, evicting entry"
    );
    cache.delete(sessionId);
  });

  return bufferPromise;
}

/**
 * Signal that a job is done with the session's photo. Decrements the ref
 * count; evicts the entry when no jobs are using it anymore.
 *
 * Safe to call even if the entry has already been evicted (no-op).
 */
export function releasePhoto(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return; // already evicted, nothing to do

  entry.refCount--;
  entry.lastAccessedAt = Date.now();

  if (entry.refCount <= 0) {
    cache.delete(sessionId);
    logger.debug({ sessionId }, "photoCache: refCount hit 0, evicted");
  } else {
    logger.debug(
      { sessionId, refCount: entry.refCount },
      "photoCache: released, still in use"
    );
  }
}

/**
 * Safety net: evict entries that haven't been touched in CACHE_TTL_MS.
 * Runs on a timer. Catches leaked entries from crashed workers that never
 * called releasePhoto().
 */
function sweepStaleEntries(): void {
  const now = Date.now();
  let evicted = 0;

  for (const [sessionId, entry] of cache) {
    if (now - entry.lastAccessedAt > CACHE_TTL_MS) {
      cache.delete(sessionId);
      evicted++;
      logger.warn(
        { sessionId, refCount: entry.refCount },
        "photoCache: force-evicted stale entry (possible leak)"
      );
    }
  }

  if (evicted > 0) {
    logger.info({ evicted, remaining: cache.size }, "photoCache: sweep done");
  }
}

// Kick off the sweeper. Node keeps the process alive as long as this timer is
// active — but since this module is only imported inside the worker process,
// that's exactly what we want. .unref() would let the process exit if this
// were the only thing keeping it running, but the worker itself holds the
// process open, so we don't need it.
setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);
