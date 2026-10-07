import { Worker, type Job } from "bullmq";
import { redisClient } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { createShipmentForSession } from "../../services/shiprocket.service.js";

/**
 * Shiprocket worker — Phase A (auto).
 *
 * Fires after PDF compilation succeeds. Thin wrapper — all logic lives in
 * createShipmentForSession() in the service. Same pattern as pdfWorker.
 *
 * Retry behavior: BullMQ retries 3 times with exponential backoff (from
 * defaultJobOptions in queues.ts). Only on final failure do we flip
 * Order.status = SHIPROCKET_FAILED and OrderSession.status = SHIPMENT_FAILED
 * so the admin can see and manually resolve.
 *
 * Phase B (updateOrder + assignAwb + generatePickup) is not a queued job —
 * it runs inline from the admin endpoint in Section 7 via
 * pushDimensionsAssignAwbAndSchedulePickup().
 */
export const shiprocketWorker = new Worker(
  "shiprocket",
  async (job: Job<{ orderSessionId: string }>) => {
    const { orderSessionId } = job.data;

    logger.info(
      { jobId: job.id, orderSessionId },
      "[Shiprocket Worker] Picked up shipment creation job"
    );

    const result = await createShipmentForSession(orderSessionId);

    logger.info(
      { jobId: job.id, orderSessionId, result },
      "[Shiprocket Worker] Job complete"
    );

    return result;
  },
  { connection: redisClient, concurrency: 5 }
);

/**
 * Final-failure handler — fires only after BullMQ has exhausted all retry
 * attempts. Flips Order.status = SHIPROCKET_FAILED and OrderSession.status =
 * SHIPMENT_FAILED so the admin can see the failure and act (retry via the
 * admin endpoint in Section 7, or cancel + refund).
 *
 * Status flips are guarded so a race with a manual admin fix cannot
 * overwrite a good state.
 */
shiprocketWorker.on("failed", async (job, err) => {
  logger.error(
    { jobId: job?.id, orderSessionId: job?.data?.orderSessionId, err },
    "[Shiprocket Worker] Job failed"
  );

  if (!job || job.attemptsMade < (job.opts.attempts ?? 3)) {
    return;
  }

  const { orderSessionId } = job.data;

  try {
    // Load the order id via the session so we can flip Order.status too.
    const session = await prisma.orderSession.findUnique({
      where: { id: orderSessionId },
      select: { order: { select: { id: true } } },
    });

    if (!session?.order) {
      logger.error(
        { orderSessionId, jobId: job.id },
        "[Shiprocket Worker] Final-failure handler: no order found for session"
      );
      return;
    }

    // Pull the id out into a local so TS doesn't lose the null narrowing
    // when we cross into the $transaction callback below.
    const orderId = session.order.id;

    await prisma.$transaction(async (tx) => {
      // Guard: only flip Order.status if it's in a state where SHIPROCKET_FAILED
      // is a valid transition. Don't overwrite READY_TO_SHIP / SHIPPED /
      // DELIVERED if the last attempt actually succeeded.
      const orderFlip = await tx.order.updateMany({
        where: {
          id: orderId,
          status: { in: ["GENERATED", "CONFIRMED"] },
        },
        data: { status: "SHIPROCKET_FAILED" },
      });

      const sessionFlip = await tx.orderSession.updateMany({
        where: { id: orderSessionId, status: "SHIPMENT_QUEUED" },
        data: { status: "SHIPMENT_FAILED" },
      });

      if (orderFlip.count > 0 || sessionFlip.count > 0) {
        logger.error(
          {
            orderSessionId,
            orderId,
            orderFlipped: orderFlip.count > 0,
            sessionFlipped: sessionFlip.count > 0,
            jobId: job.id,
          },
          "[Shiprocket Worker] All retries exhausted — flipped to failure states"
        );
      } else {
        logger.warn(
          { orderSessionId, orderId, jobId: job.id },
          "[Shiprocket Worker] Final-failure handler fired but no status change — states already past this point"
        );
      }
    });
  } catch (handlerErr) {
    logger.error(
      { orderSessionId, jobId: job.id, handlerErr },
      "[Shiprocket Worker] Failed to flip failure states — manual intervention needed"
    );
  }
});
