// src/jobs/workers/stuckPageSweeper.ts
//
// Safety net for PageVersion rows that are still "generating" but that no
// BullMQ job will ever finish. The worker's `failed` handler covers jobs BullMQ
// gives up on while the DB is reachable; this covers everything else:
//   - the DB was down when the `failed` handler ran
//   - the process died mid-job
//   - the row was created but the job was never added (Redis down at enqueue)
//
// A row is only a candidate after STUCK_AFTER_MS without an update, and is only
// failed once BullMQ confirms nothing is still going to run it. Age alone is not
// enough — a page can legitimately sit in a long queue.

import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { sdGenerationQueue } from "../queues.js";
import { settleTerminalPageFailure } from "./generationWorker.js";

// Comfortably above the longest a healthy page goes without a status write
// (RunPod polling caps at ~17 min).
const STUCK_AFTER_MS = 30 * 60 * 1000;
const SWEEP_BATCH_SIZE = 200;

/** BullMQ states meaning a job is still going to run — leave the row alone. */
const LIVE_JOB_STATES = new Set([
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
]);

// One sweep at a time per process. Overlap across instances is safe anyway —
// every write below is status-guarded.
let sweepRunning = false;

/**
 * Fails every stuck PageVersion whose BullMQ job is gone, failed, or completed
 * without the row reaching SD_READY, then runs the usual session completion
 * checks so the customer gets a regenerate option instead of a spinner.
 *
 * Returns how many rows were marked FAILED.
 */
export async function sweepStuckPageVersions(): Promise<number> {
  if (sweepRunning) return 0;
  sweepRunning = true;

  try {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);

    const candidates = await prisma.pageVersion.findMany({
      where: {
        status: { notIn: ["SD_READY", "FAILED"] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: SWEEP_BATCH_SIZE,
    });

    if (candidates.length === 0) return 0;

    let failed = 0;
    let alive = 0;
    let errors = 0;

    // Sequential on purpose: this is a background chore, and a burst of
    // parallel Redis + DB calls would compete with live generation work.
    for (const { id } of candidates) {
      try {
        // Every page job uses jobId = pageVersionId (see addPageJobs).
        const job = await sdGenerationQueue.getJob(id);
        const state = job ? await job.getState() : "missing";

        if (LIVE_JOB_STATES.has(state)) {
          alive++;
          continue;
        }

        const reason =
          state === "failed"
            ? job?.failedReason || "Generation job failed"
            : state === "completed"
              ? "Generation job completed but the page was never marked ready"
              : "No generation job found for this page";

        const { flipped } = await settleTerminalPageFailure(id, reason, {
          source: "sweeper",
          staleBefore: cutoff,
        });

        if (flipped) failed++;
      } catch (err) {
        // Redis or DB unreachable — never guess. The row stays a candidate
        // and is retried on the next sweep.
        errors++;
        logger.error(
          { pageVersionId: id, err },
          "[Stuck Page Sweeper] Could not check page"
        );
      }
    }

    logger.info(
      { checked: candidates.length, failed, alive, errors },
      "[Stuck Page Sweeper] Sweep done"
    );

    return failed;
  } finally {
    sweepRunning = false;
  }
}
