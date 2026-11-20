import { sweepExpiredSessions } from "./session.service.js";
import { sweepExpiredCoupons } from "./coupon.service.js";
import { sweepStuckPageVersions } from "../jobs/workers/stuckPageSweeper.js";
import { sweepSampleSessions } from "../jobs/workers/sampleSweeper.js";
import { sweepReminders } from "./reminder.service.js";
import { sweepBroadcasts } from "./broadcast.service.js";
import { logger } from "../lib/logger.js";

/**
 * Runs the background sweeps once, on demand, from an outside timer
 * (Cloud Scheduler). In production the service scales to zero and its CPU is
 * limited outside requests, so the setInterval timers in jobs/workers/index.ts
 * only fire while someone happens to be using the site. These sweeps are safe to
 * run twice or on two instances at once (guarded updateMany, see the comment in
 * jobs/workers/index.ts), so the timers stay as they are.
 */

export type SweepResult = {
  name: string;
  count: number | null;
  ms: number;
  error: string | null;
};

const SWEEPS: { name: string; run: () => Promise<number> }[] = [
  { name: "expired sessions", run: sweepExpiredSessions },
  { name: "stuck pages", run: sweepStuckPageVersions },
  { name: "expired coupons", run: sweepExpiredCoupons },
  { name: "sample books", run: sweepSampleSessions },
  // After the quick sweeps on purpose: it and the broadcast sweep can take the longest, and the others must never wait for them.
  { name: "reminder emails", run: sweepReminders },
  // After the reminders on purpose: they claim the day's budget first, a broadcast takes what is left.
  { name: "broadcast emails", run: sweepBroadcasts },
];

// One run at a time per instance: a second call while one is running is a no-op.
let running = false;

// A sweep that never answers (Redis or the database unreachable) must not keep "running" set for ever: after
// this long it is reported as timed out and the next call may start. The hung call itself cannot be cancelled.
export const SWEEP_TIMEOUT_MS = 120_000;

function withTimeout(work: Promise<number>): Promise<number> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), SWEEP_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function runScheduledSweeps(): Promise<{
  skipped: boolean;
  results: SweepResult[];
}> {
  if (running) {
    logger.warn(
      "[Scheduled sweeps] a run is still in progress, this call did nothing"
    );
    return { skipped: true, results: [] };
  }
  running = true;
  try {
    const results: SweepResult[] = [];
    for (const sweep of SWEEPS) {
      const startedAt = Date.now();
      try {
        const count = await withTimeout(sweep.run());
        results.push({
          name: sweep.name,
          count,
          ms: Date.now() - startedAt,
          error: null,
        });
      } catch (err) {
        // One failing sweep must not stop the others.
        logger.error({ err }, `[Scheduled sweeps] ${sweep.name} failed`);
        results.push({
          name: sweep.name,
          count: null,
          ms: Date.now() - startedAt,
          // Detail stays in the log; the response only says what kind of failure it was.
          error:
            err instanceof Error && err.message === "timed out"
              ? "timed out"
              : "failed",
        });
      }
    }
    logger.info({ results }, "[Scheduled sweeps] run finished");
    return { skipped: false, results };
  } finally {
    running = false;
  }
}
