import { Worker, type Job } from "bullmq";
import { redisClient } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { compilePdfForSession } from "../../services/session.service.js";

/**
 * PDF compilation worker.
 * Thin wrapper — all logic lives in compilePdfForSession() in the service.
 *
 * Retry behavior: BullMQ retries 3 times with exponential backoff (from
 * defaultJobOptions in queues.ts). Only on final failure do we flip the
 * session to PDF_FAILED — transient errors get another shot first.
 */
export const pdfWorker = new Worker(
  "pdf-compilation",
  async (job: Job<{ orderSessionId: string }>) => {
    const { orderSessionId } = job.data;

    logger.info(
      { jobId: job.id, orderSessionId },
      "[PDF Worker] Picked up compilation job"
    );

    const result = await compilePdfForSession(orderSessionId);

    logger.info(
      { jobId: job.id, orderSessionId, pdfDownloadUrl: result.pdfDownloadUrl },
      "[PDF Worker] Compilation complete"
    );

    return result;
  },
  { connection: redisClient, concurrency: 5 }
);

/**
 * Final-failure handler — fires only after BullMQ has exhausted all retry
 * attempts (3 by default). Flips session to PDF_FAILED so admin can see it
 * and manually retry. Uses status guard so we don't overwrite a stale
 * SHIPMENT_QUEUED / COMPLETED / etc.
 */
pdfWorker.on("failed", async (job, err) => {
  logger.error(
    { jobId: job?.id, orderSessionId: job?.data?.orderSessionId, err },
    "[PDF Worker] Job failed"
  );

  // Only run the final-fail handler when we've exhausted all attempts.
  // If more retries remain, BullMQ will re-fire this handler on each retry
  // and we'd flip prematurely.
  if (!job || job.attemptsMade < (job.opts.attempts ?? 3)) {
    return;
  }

  const { orderSessionId } = job.data;

  try {
    // Guard on COMPILING_PDF only — don't overwrite if compilation actually
    // succeeded on the last attempt (race between worker success and BullMQ
    // failure classification is extremely unlikely but this is cheap defense).
    const { count } = await prisma.orderSession.updateMany({
      where: { id: orderSessionId, status: "COMPILING_PDF" },
      data: { status: "PDF_FAILED" },
    });

    if (count > 0) {
      logger.error(
        { orderSessionId, jobId: job.id },
        "[PDF Worker] All retries exhausted — session flipped to PDF_FAILED"
      );
    } else {
      logger.warn(
        { orderSessionId, jobId: job.id },
        "[PDF Worker] Failed handler fired but session not at COMPILING_PDF — no status change"
      );
    }
  } catch (handlerErr) {
    logger.error(
      { orderSessionId, jobId: job.id, handlerErr },
      "[PDF Worker] Failed to flip session to PDF_FAILED — manual intervention needed"
    );
  }
});