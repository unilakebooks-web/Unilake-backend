import { sweepExpiredSessions } from "./session.service.js";
import { sweepExpiredCoupons } from "./coupon.service.js";
import { sweepStuckPageVersions } from "../jobs/workers/stuckPageSweeper.js";
import { logger } from "../lib/logger.js";

/**
 * Runs the three background sweeps once, on demand, from an outside timer
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
];

// One run at a time per instance: a second call while one is running is a no-op.
let running = false;

export async function runScheduledSweeps(): Promise<{
  skipped: boolean;
  results: SweepResult[];
}> {
  if (running) return { skipped: true, results: [] };
  running = true;
  try {
    const results: SweepResult[] = [];
    for (const sweep of SWEEPS) {
      const startedAt = Date.now();
      try {
        const count = await sweep.run();
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
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
    }
    logger.info({ results }, "[Scheduled sweeps] run finished");
    return { skipped: false, results };
  } finally {
    running = false;
  }
}
