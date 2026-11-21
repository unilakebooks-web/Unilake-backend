import { prisma } from "../lib/prisma.js";
import { verifyWebhookSignature } from "../lib/razorpay.js";
import { logger } from "../lib/logger.js";
import { enqueuePaidGenerationJobs } from "./session.service.js";
import { Prisma, type Order, type OrderSession } from "../generated/prisma/client.js";
import { config } from "../config/env.js";
import { processShiprocketStatusUpdate } from "./shiprocket.service.js";
import {
  notifyPaidAfterDeletion,
  notifyPaymentReceived,
} from "./notification.service.js";
import { assignBillNumber } from "./billOfSupply.service.js";
import { switchOffUsedUpCouponOfOrder } from "./coupon.service.js";
import {
  findOrderBySupersededRazorpayOrderId,
  redeemCouponInTx,
} from "./couponCheckout.service.js";

/**
 * Handle an incoming Razorpay webhook.
 *
 * Flow:
 *  1. Verify signature (400 on mismatch → Razorpay stops retrying).
 *  2. Parse payload.
 *  3. Insert WebhookEvent row (unique on eventId — dedupes retries).
 *  4. On `payment.captured`: flip Order + Session to PAID, enqueue paid pages.
 *  5. On `payment.failed`: log for support, no state change.
 *  6. Everything else: log and ignore.
 *
 * Returns nothing meaningful; controller returns 200 as long as no throw.
 */

export async function handleRazorpayWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  deliveryEventId: string | undefined
): Promise<void> {
  // 1. Signature check
  if (!signature) {
    throw new WebhookVerificationError("Missing x-razorpay-signature header");
  }

  const rawBodyStr = rawBody.toString("utf8");
  if (!verifyWebhookSignature(rawBodyStr, signature)) {
    throw new WebhookVerificationError("Invalid webhook signature");
  }

  // 2. Parse
  let payload: any;
  try {
    payload = JSON.parse(rawBodyStr);
  } catch {
    throw new WebhookVerificationError("Malformed webhook payload");
  }

  const eventType: string = payload.event;
  const paymentEntity = payload.payload?.payment?.entity;
  const entityId: string | undefined =
    paymentEntity?.id ?? payload.payload?.order?.entity?.id;

  // Idempotency key.
  //
  // `x-razorpay-event-id` is unique per EVENT and stable across Razorpay's
  // retries of that event — exactly what this needs.
  //
  // It must NOT be the payment id. A single payment emits payment.authorized,
  // order.paid AND payment.captured, all carrying the same payment id. Keying on
  // it meant whichever event landed first claimed the unique constraint, and
  // every later one — including the only event that mutates state,
  // payment.captured — was discarded as a duplicate and the order was stranded
  // at CREATED forever.
  //
  // The fallback keeps eventType in the key so that collision cannot return if
  // the header is ever absent.
  const eventId: string | undefined =
    deliveryEventId ?? (entityId ? `${eventType}:${entityId}` : undefined);

  if (!eventId) {
    logger.warn(
      { eventType },
      "Razorpay webhook missing eventId — cannot dedupe, ignoring"
    );
    return;
  }

  const razorpayOrderId: string | undefined = paymentEntity?.order_id;

  // 3. Idempotency — insert WebhookEvent; P2002 = duplicate = already processed
  try {
    await prisma.webhookEvent.create({
      data: {
        source: "razorpay",
        eventId,
        eventType,
        payloadJson: payload,
        orderId: null, // filled in below if we can resolve it
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      logger.info(
        { eventId, eventType },
        "Duplicate Razorpay webhook — already processed, skipping"
      );
      return;
    }
    throw error;
  }

  // 4. Dispatch by event type
  switch (eventType) {
    case "payment.captured":
      await handlePaymentCaptured(razorpayOrderId, paymentEntity?.id, eventId);
      break;

    case "payment.failed":
      logger.warn(
        {
          razorpayOrderId,
          razorpayPaymentId: paymentEntity?.id,
          errorCode: paymentEntity?.error_code,
          errorDescription: paymentEntity?.error_description,
        },
        "Razorpay payment failed — no state change, user can retry"
      );
      break;

    default:
      logger.info({ eventType, eventId }, "Razorpay webhook event ignored");
  }
}

async function handlePaymentCaptured(
  razorpayOrderId: string | undefined,
  razorpayPaymentId: string | undefined,
  eventId: string
): Promise<void> {
  if (!razorpayOrderId || !razorpayPaymentId) {
    logger.error(
      { eventId, razorpayOrderId, razorpayPaymentId },
      "payment.captured missing order_id or payment id — cannot process"
    );
    return;
  }

  // Look up our Order by the Razorpay order id
  const order = await prisma.order.findUnique({
    where: { razorpayOrderId },
    include: { orderSession: true },
  });

  if (!order) {
    // A customer who changed or removed a coupon after starting checkout got a
    // new Razorpay order; a payment on the replaced one is not an unknown order.
    const superseded = await findOrderBySupersededRazorpayOrderId(razorpayOrderId);
    if (superseded) {
      logger.error(
        {
          razorpayOrderId,
          razorpayPaymentId,
          orderId: superseded.id,
          currentRazorpayOrderId: superseded.razorpayOrderId,
        },
        "payment.captured on a SUPERSEDED Razorpay order — the customer paid an earlier amount, admin follow-up needed"
      );
      // Attach the event to the order so the admin sees the payment on the order page.
      await prisma.webhookEvent
        .update({ where: { eventId }, data: { orderId: superseded.id } })
        .catch((err) => {
          logger.error({ err, eventId }, "Could not link the superseded payment event to its order");
        });
      return;
    }

    logger.error(
      { razorpayOrderId, razorpayPaymentId },
      "payment.captured: no local Order found for Razorpay order — orphan payment, admin follow-up needed"
    );
    return;
  }

  // Idempotency at the state level — if Order is already past CREATED,
  // this webhook is a redelivery we've already handled at business level.
  const enqueueAlreadySucceeded =
    order.orderSession.status !== "PAID" &&
    order.orderSession.status !== "AWAITING_PAYMENT";

  if (order.status !== "CREATED" && enqueueAlreadySucceeded) {
    logger.info(
      { orderId: order.id, currentStatus: order.status, sessionStatus: order.orderSession.status },
      "payment.captured on already-processed order — skipping"
    );
    return;
  }

  // Backfill the WebhookEvent.orderId now that we resolved the order
  await prisma.webhookEvent
    .update({
      where: { eventId },
      data: { orderId: order.id },
    })
    .catch(() => {
      // Non-fatal — the event row exists, just missing the FK backfill
    });

  await applyCapturedPayment(order, razorpayOrderId, razorpayPaymentId, eventId);
}

/**
 * Everything that happens once a captured payment has been matched to its Order:
 * flip Order and session to PAID, then enqueue the paid pages, then the email.
 *
 * Called by the Razorpay webhook (with its event id) and by the customer's own
 * payment confirmation (paymentConfirmation.service.ts, no event id: there is
 * no webhook row to remove if a step fails). Every step is guarded, so a repeat
 * call, or the webhook and the confirmation racing, ends with exactly one flip,
 * one bill number, one set of jobs and one email.
 */
export async function applyCapturedPayment(
  order: Order & { orderSession: OrderSession },
  razorpayOrderId: string,
  razorpayPaymentId: string,
  eventId: string | null
): Promise<void> {
  // The idempotency row exists only for a webhook delivery.
  const dropWebhookRow = async () => {
    if (eventId) await prisma.webhookEvent.delete({ where: { eventId } });
  };

  // Flip Order + Session in a transaction. Enqueue OUTSIDE.
  let repricedMeanwhile = false;
  // Automatic data deletion (feature 6): set when this session's files were already deleted.
  let paidAfterDeletion = false;
  let paidAfterDeletionFirst = false;
  await prisma.$transaction(async (tx) => {
    const { count: orderFlipped } = await tx.order.updateMany({
      where: { id: order.id, status: "CREATED", razorpayOrderId },
      data: {
        status: "PAID",
        razorpayPaymentId,
      },
    });

    // The customer changed the coupon after we looked the order up, so this
    // payment is now for a superseded Razorpay order. Nothing was flipped;
    // leave the order for the admin notice (as for any superseded payment).
    if (orderFlipped === 0) {
      const current = await tx.order.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      if (current?.status === "CREATED") {
        repricedMeanwhile = true;
        return;
      }
    }

    // Bill of Supply number — INR orders only, and only by the call that
    // actually flipped the order, so a redelivered webhook never takes a
    // second number. In this transaction so a rollback takes none.
    if (orderFlipped === 1 && order.currency === "INR") {
      await assignBillNumber(tx, order.id, new Date());
    }

    // A coupon reserved for this order becomes redeemed with the payment, in the
    // same transaction. Orders without a coupon do nothing here.
    if (orderFlipped === 1) {
      await redeemCouponInTx(tx, order.id);
    }

    await tx.orderSession.updateMany({
      where: { id: order.orderSessionId, status: "AWAITING_PAYMENT" },
      data: { status: "PAID" },
    });

    // The marker is read here, after the guarded flip, so a deletion claim that committed while this webhook waited
    // for the order lock is seen (the order lock orders the two). A marked session means its files are gone: the
    // payment stays recorded but no book can be made. The flag is written in this transaction and only once.
    const marker = await tx.orderSession.findUnique({
      where: { id: order.orderSessionId },
      select: { photoDeletedAt: true, filesDeletedAt: true },
    });
    if (marker && (marker.photoDeletedAt || marker.filesDeletedAt)) {
      paidAfterDeletion = true;
      // Flag and mail only for the delivery that actually flipped the order: a redelivery only skips the book.
      if (orderFlipped === 1) {
        const flagged = await tx.$executeRaw`UPDATE "orders" SET "paidAfterDeletionAt" = ${new Date()} WHERE "id" = ${order.id} AND "paidAfterDeletionAt" IS NULL`;
        paidAfterDeletionFirst = flagged === 1;
      }
    }
  }).catch(async (error) => {
    // The idempotency row was stored before processing. If the status change
    // failed, remove it so Razorpay's retry is processed instead of skipped as a
    // duplicate (the order would otherwise stay unpaid after the customer paid).
    await dropWebhookRow()
      .catch(() => {
        logger.error(
          { eventId, orderId: order.id },
          "Failed to clean up WebhookEvent row after the payment transaction failed"
        );
      });
    throw error;
  });

  if (repricedMeanwhile) {
    logger.error(
      { orderId: order.id, razorpayOrderId, razorpayPaymentId, eventId },
      "Payment captured on a Razorpay order that was superseded a moment ago — order left unpaid for manual follow-up"
    );
    return;
  }

  logger.info(
    {
      orderId: order.id,
      sessionId: order.orderSessionId,
      razorpayPaymentId,
    },
    "Payment captured — Order + Session flipped to PAID"
  );

  if (paidAfterDeletion) {
    // No generation, no "creating your book" email: the photo is gone. An admin follows up (refund or a new photo).
    logger.error(
      { orderId: order.id, sessionId: order.orderSessionId, razorpayPaymentId },
      "Payment captured after the files of this preview were deleted — no book can be made, admin follow-up needed"
    );
    if (paidAfterDeletionFirst) {
      notifyPaidAfterDeletion(order.orderSessionId).catch((err) => {
        logger.error(
          { orderId: order.id, err },
          "notifyPaidAfterDeletion failed (swallowed)"
        );
      });
    }
    await switchOffUsedUpCouponOfOrder(order.id).catch((err) => {
      logger.warn(
        { orderId: order.id, err },
        "Could not switch off a used-up coupon after payment"
      );
    });
    return;
  }

  // Enqueue paid-page generation OUTSIDE the transaction.
  // Never enqueue inside $transaction (Redis doesn't roll back with Prisma).
  const jobsEnqueued = await enqueuePaidGenerationJobs(
    order.orderSessionId
  ).catch(async (error) => {
    // The webhook and the customer's own confirmation can reach this point for the same payment at
    // once: the other caller is creating the same page rows (unique constraint) and queueing them.
    // This one stops here; the other one flips the session and sends the email.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      logger.warn(
        { orderId: order.id },
        "Paid-page enqueue collided with another caller for the same payment — leaving it to that caller"
      );
      // The webhook must not answer "done" for work the other caller may still fail at: it drops its row
      // and reports an error, so Razorpay re-sends it later (skipped as already processed if the other
      // caller finished, run again if that caller failed). The customer's own confirmation has no row
      // and no retry to ask for, so it just steps aside.
      if (eventId) {
        await dropWebhookRow().catch(() => undefined);
        throw error;
      }
      return null;
    }

    await dropWebhookRow()
      .catch(() => {
        // If cleanup itself fails, log and press on with the re-throw.
        // Ops will see the stuck row and can clear it manually.
        logger.error(
          { eventId, orderId: order.id },
          "Failed to clean up WebhookEvent row after enqueue failure"
        );
      });

    // `err`, not `error`: pino only runs its Error serializer on the `err` key.
    // Under any other key an Error has no enumerable fields and logs as `{}` —
    // which is how a BullMQ priority overflow passed for a vague Redis problem.
    logger.error(
      { orderId: order.id, err: error },
      "Paid-page enqueue failed — re-throwing so the caller retries (Razorpay re-sends the webhook; the customer's page asks again)"
    );
    throw error;
  });

  if (jobsEnqueued === null) return;

  // Flip session to GENERATING_PAID once jobs are in Redis
  const { count: generationStarted } = await prisma.orderSession.updateMany({
    where: { id: order.orderSessionId, status: "PAID" },
    data: { status: "GENERATING_PAID" },
  });

  logger.info(
    { orderId: order.id, jobsEnqueued },
    "Paid-page generation enqueued after payment"
  );

  // Payment-received email — exactly once. Only the delivery whose guarded
  // PAID → GENERATING_PAID flip actually matched sends it: a retry after a
  // failed enqueue never reached this line the first time, and any later
  // duplicate finds the session already past PAID (count 0). Fire-and-forget,
  // so a Resend outage can never make Razorpay retry the webhook.
  if (generationStarted > 0) {
    notifyPaymentReceived(order.orderSessionId).catch((err) => {
      logger.error(
        { orderId: order.id, err },
        "notifyPaymentReceived failed (swallowed)"
      );
    });
  }

  // The paid use may have been the coupon's last: switch it off. One statement,
  // last and best effort, so it never delays the paid-page jobs or the reply and
  // can never fail a payment; the coupon sweep catches a miss.
  await switchOffUsedUpCouponOfOrder(order.id).catch((err) => {
    logger.warn(
      { orderId: order.id, err },
      "Could not switch off a used-up coupon after payment"
    );
  });
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

// ============================================================
// SHIPROCKET WEBHOOK
// ============================================================

/**
 * Handle an incoming Shiprocket tracking webhook.
 *
 * Differences from the Razorpay handler:
 *   - Auth: plain token comparison against x-api-key header (no HMAC)
 *   - No provider-supplied event id — we synthesise one from
 *     awb + current_status_id + current_timestamp so retries of the SAME
 *     event dedupe correctly but genuinely new events (later scan, new
 *     status) process normally.
 *   - Business logic delegated to processShiprocketStatusUpdate() in
 *     shiprocket.service.ts, same pattern as razorpay -> session.service.ts.
 */
export async function handleShiprocketWebhook(
  rawBody: Buffer,
  providedToken: string | undefined
): Promise<void> {
  // 1. Token verify
  if (!providedToken) {
    throw new WebhookVerificationError("Missing x-api-key header");
  }
  if (providedToken !== config.shiprocket.webhookToken) {
    throw new WebhookVerificationError("Invalid webhook token");
  }

  // 2. Parse
  const rawBodyStr = rawBody.toString("utf8");
  let payload: any;
  try {
    payload = JSON.parse(rawBodyStr);
  } catch {
    throw new WebhookVerificationError("Malformed webhook payload");
  }

  const awb: string | number | undefined = payload?.awb;
  const currentStatus: string | undefined = payload?.current_status;
  const currentStatusId: number | undefined = payload?.current_status_id;
  const currentTimestamp: string | undefined = payload?.current_timestamp;
  const courierName: string | undefined = payload?.courier_name;

  // 3. Idempotency key.
  //
  // Shiprocket does not send an event id header. Same event redelivered by
  // Shiprocket carries identical awb + status_id + timestamp, so the tuple
  // is a stable dedup key. If any of those three is missing we cannot
  // dedupe safely — log and drop rather than double-process.
  if (
    awb === undefined ||
    currentStatusId === undefined ||
    !currentTimestamp
  ) {
    logger.warn(
      { awb, currentStatusId, currentTimestamp, currentStatus },
      "Shiprocket webhook missing dedup fields — cannot dedupe, ignoring"
    );
    return;
  }
  const eventId = `shiprocket:${awb}:${currentStatusId}:${currentTimestamp}`;
  const eventType = currentStatus ?? `status_${currentStatusId}`;

  // 4. Insert WebhookEvent — P2002 = duplicate = already processed.
  try {
    await prisma.webhookEvent.create({
      data: {
        source: "shiprocket",
        eventId,
        eventType,
        payloadJson: payload,
        orderId: null, // backfilled below once we resolve the order
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      logger.info(
        { eventId, eventType, awb },
        "Duplicate Shiprocket webhook — already processed, skipping"
      );
      return;
    }
    throw error;
  }

  // 5. Delegate to service for the actual state update.
  const result = await processShiprocketStatusUpdate(payload);

  // 6. Backfill orderId on the WebhookEvent row if we resolved one.
  if (result.orderId) {
    await prisma.webhookEvent
      .update({
        where: { eventId },
        data: { orderId: result.orderId },
      })
      .catch(() => {
        // Non-fatal — event row exists, just missing FK backfill.
      });
  }

  logger.info(
    {
      eventId,
      eventType,
      awb,
      courierName,
      orderId: result.orderId ?? null,
      statusFlipped: "statusFlipped" in result ? result.statusFlipped : false,
    },
    "Shiprocket webhook processed"
  );
}