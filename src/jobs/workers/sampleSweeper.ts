// src/jobs/workers/sampleSweeper.ts
//
// Removes admin sample books (OrderSession.isSample) once they are over: their files in both
// buckets, then their rows. A sample is over when it expired (its 6-hour life ended, or an admin
// discarded it) and SAMPLE_CLEANUP_MARGIN_MS has passed since.

import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { deletePrefix } from "../../lib/r2.js";
import {
  SAMPLE_CLEANUP_MARGIN_MS,
  SAMPLE_SWEEP_BATCH,
  SAMPLE_SWEEP_BUDGET_MS,
  SAMPLE_SWEEP_STALE_MS,
} from "../../config/sample.js";

// One sweep at a time per process. Overlap across instances is safe: every delete below is
// guarded on isSample and on there being no Order, and deleting twice is a no-op. A run that has
// not finished after SAMPLE_SWEEP_STALE_MS is taken as hung, so one stuck storage call cannot stop
// every later run.
let sweepStartedAt: number | null = null;

/**
 * Deletes the files and rows of every sample that is over. A sample with a page that is still being
 * generated is skipped until the next run (a late job could write a file after the cleanup). A failure
 * leaves that sample's rows for the next run, and the run then throws after trying every sample, so
 * the scheduled-sweeps endpoint answers 500 and the failure is not silent (a child's photo would
 * otherwise stay in storage unnoticed). A run stops starting new samples when its time budget is used.
 * A failed sample moves to the back of the queue (its updatedAt is bumped), so a few that always fail
 * cannot starve the others. Page versions still QUEUED in an ended sample are deleted first, as
 * Discard does, so a backlog of waiting jobs cannot keep a child's photo past its time.
 *
 * Returns how many samples were removed.
 */
export async function sweepSampleSessions(): Promise<number> {
  const startedAt = Date.now();
  if (
    sweepStartedAt !== null &&
    startedAt - sweepStartedAt < SAMPLE_SWEEP_STALE_MS
  ) {
    return 0;
  }
  sweepStartedAt = startedAt;

  try {
    const cutoff = new Date(startedAt - SAMPLE_CLEANUP_MARGIN_MS);

    // Deleting QUEUED rows is only the first step: a worker may have just picked one up and may still
    // write files for it. Samples that had such rows are left for the next run, so that the worker has
    // failed on its missing row before the folder is deleted.
    const queuedWhere = {
      status: "QUEUED" as const,
      orderSession: {
        isSample: true,
        expiresAt: { lt: cutoff },
        order: { is: null },
      },
    };
    const withQueued = await prisma.pageVersion.findMany({
      where: queuedWhere,
      select: { orderSessionId: true },
      distinct: ["orderSessionId"],
    });
    await prisma.pageVersion.deleteMany({ where: queuedWhere });
    const waitForNextRun = withQueued.map((row) => row.orderSessionId);

    const candidates = await prisma.orderSession.findMany({
      where: {
        id: { notIn: waitForNextRun },
        isSample: true,
        expiresAt: { lt: cutoff },
        order: { is: null },
        // The same "in flight" meaning as stuckPageSweeper.ts: anything not finished or failed.
        pageVersions: {
          none: { status: { notIn: ["SD_READY", "FAILED"] } },
        },
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: SAMPLE_SWEEP_BATCH,
    });

    const deadline = Date.now() + SAMPLE_SWEEP_BUDGET_MS;
    let removed = 0;
    let failed = 0;
    for (const { id } of candidates) {
      if (Date.now() > deadline) break;
      try {
        const prefix = `sessions/${id}/`;
        await deletePrefix("public", prefix);
        await deletePrefix("private", prefix);

        const { count } = await prisma.orderSession.deleteMany({
          where: { id, isSample: true, order: { is: null } },
        });
        removed += count;
      } catch (err) {
        failed++;
        logger.error({ err, sessionId: id }, "[Sample Sweeper] Cleanup failed");
        await prisma.orderSession
          .updateMany({
            where: { id, isSample: true },
            data: { updatedAt: new Date() },
          })
          .catch((bumpErr) =>
            logger.warn(
              { err: bumpErr, sessionId: id },
              "[Sample Sweeper] Could not move the failed sample to the back of the queue"
            )
          );
      }
    }

    if (removed > 0) {
      logger.info({ removed }, "[Sample Sweeper] Removed expired samples");
    }

    if (failed > 0) {
      throw new Error(
        `[Sample Sweeper] cleanup failed for ${failed} sample(s)`
      );
    }

    return removed;
  } finally {
    // Only the run that set the time clears it (a later run may have taken over a hung one).
    if (sweepStartedAt === startedAt) sweepStartedAt = null;
  }
}
