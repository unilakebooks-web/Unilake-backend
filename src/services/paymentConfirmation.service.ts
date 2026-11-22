import { prisma } from "../lib/prisma.js";
import { razorpay, toSmallestUnit } from "../lib/razorpay.js";
import { logger } from "../lib/logger.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { SAMPLE_REFUSAL_MESSAGE } from "../config/sample.js";
import type { Order, OrderSessionStatus } from "../generated/prisma/client.js";
import { REVENUE_STATUSES } from "../config/stats.js";
import { applyCapturedPayment } from "./webhook.service.js";

/**
 * Lets the customer's own page ask "was my payment received?", so an order is
 * marked paid even when Razorpay's webhook never arrives (it did not in
 * production: no webhook was set up, BUG-029). The webhook stays the main path;
 * both end in applyCapturedPayment, which is safe to run twice.
 *
 * Nothing the browser sends is trusted: the server asks Razorpay for the
 * payments of the order's own Razorpay order and applies only a captured,
 * unrefunded payment whose order, currency and amount match the Order row.
 */

/** A repeat call for the same session inside this time answers without asking Razorpay. */
const MIN_INTERVAL_MS = 3_000;
/** Longest wait for Razorpay; the customer's page simply asks again. */
const RAZORPAY_TIMEOUT_MS = 8_000;
/**
 * A PAID order whose session is still PAID or AWAITING_PAYMENT is re-run only when it has been that way
 * this long: before that, the webhook or another confirmation is probably still queueing its pages.
 */
const RERUN_AFTER_MS = 60_000;
/** Replaced Razorpay orders looked at per check (the most recent ones). */
const MAX_SUPERSEDED_LOOKUPS = 3;
/** Razorpay lookups running at once from this endpoint. */
const MAX_LOOKUPS_AT_ONCE = 5;
/** The throttle map is cleaned of entries older than PRUNE_AFTER_MS once it holds more than PRUNE_ABOVE sessions. */
const PRUNE_ABOVE = 1_000;
const PRUNE_AFTER_MS = 60_000;

// Per process: Cloud Run may run several instances, each with its own map.
const lastCheck = new Map<string, number>();
// Alerts already logged in this process (a key per kind and session: "mismatch:", "superseded:" and the
// "superseded-checked:" done-mark): each is logged once, not on every poll of a customer waiting for 90 seconds.
// Emptied when it grows past PRUNE_ABOVE, so an alert may then be logged again.
const alertsLogged = new Set<string>();
let lookupsRunning = 0;

export interface PaymentConfirmationResult {
  status: OrderSessionStatus;
  /** True once the order is paid (by this call or earlier). */
  confirmed: boolean;
}

/** Exported for the tests. (Not the private `withTimeout` of scheduledSweeps.service.ts: that one has another signature.) */
export function withRazorpayTimeout<T>(
  work: Promise<T>,
  limitMs = RAZORPAY_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Razorpay did not answer in time")),
      limitMs
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Logs an alert once per key in this process (the set is emptied when it grows past PRUNE_ABOVE). */
function logOnce(key: string, log: () => void): void {
  if (alertsLogged.has(key)) return;
  if (alertsLogged.size > PRUNE_ABOVE) alertsLogged.clear();
  alertsLogged.add(key);
  log();
}

/**
 * True when this session was checked less than MIN_INTERVAL_MS ago. Otherwise records now as the
 * last check. Called before the first await of a check, so two calls arriving together cannot
 * both reach Razorpay.
 */
function isThrottled(sessionId: string): boolean {
  const now = Date.now();
  const last = lastCheck.get(sessionId);
  if (last !== undefined && now - last < MIN_INTERVAL_MS) return true;
  lastCheck.set(sessionId, now);
  if (lastCheck.size > PRUNE_ABOVE) {
    for (const [id, at] of lastCheck) {
      if (now - at > PRUNE_AFTER_MS) lastCheck.delete(id);
    }
  }
  return false;
}

/**
 * A payment on an earlier Razorpay order of this Order (the customer changed the coupon) is
 * reported like the webhook does, never applied. Once per process and session, so the customer's
 * polling does not repeat the alert.
 */
async function reportSupersededPayments(
  sessionId: string,
  order: Pick<Order, "id" | "razorpayOrderId" | "supersededRazorpayOrderIds">
): Promise<void> {
  // Looked at once per process and session; a lookup that failed is tried again next time.
  const doneKey = `superseded-checked:${sessionId}`;
  if (alertsLogged.has(doneKey)) return;
  // The latest few only: each lookup can wait up to the Razorpay limit.
  for (const oldId of order.supersededRazorpayOrderIds.slice(
    -MAX_SUPERSEDED_LOOKUPS
  )) {
    const old = await withRazorpayTimeout(razorpay.orders.fetchPayments(oldId));
    const paidOld = (old.items ?? []).find((p) => p.status === "captured");
    if (paidOld) {
      logOnce(`superseded:${sessionId}`, () =>
        logger.error(
          {
            razorpayOrderId: oldId,
            razorpayPaymentId: paidOld.id,
            orderId: order.id,
            currentRazorpayOrderId: order.razorpayOrderId,
          },
          "Captured payment found on a SUPERSEDED Razorpay order, the customer paid an earlier amount, admin follow-up needed"
        )
      );
    }
  }
  // Marked done only now, after every lookup succeeded (a failed one is tried again next time).
  alertsLogged.add(doneKey);
}

export async function confirmPaymentWithRazorpay(
  sessionId: string
): Promise<PaymentConfirmationResult> {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: { order: true },
  });

  if (!session) {
    throw new NotFoundError("Session not found");
  }

  if (session.isSample) {
    throw new ConflictError(SAMPLE_REFUSAL_MESSAGE);
  }

  const { order, ...orderSession } = session;

  // No order yet: nothing was started, nothing to confirm.
  if (!order) {
    return { status: session.status, confirmed: false };
  }

  // An order that is PAID while its session is still PAID or AWAITING_PAYMENT
  // had its payment recorded but not its pages queued (the queue failed). The
  // webhook retries that case; here it is run again too.
  const needsRerun =
    order.status === "PAID" &&
    // Paid after the files were deleted (feature 6): no book can be made, so there is nothing to run again.
    !order.paidAfterDeletionAt &&
    (session.status === "PAID" || session.status === "AWAITING_PAYMENT") &&
    Date.now() - order.updatedAt.getTime() > RERUN_AFTER_MS;

  // What is known without asking anyone: paid (or further along) is confirmed, a cancelled order is not.
  const known: PaymentConfirmationResult = {
    status: session.status,
    confirmed: REVENUE_STATUSES.includes(order.status),
  };

  if (order.status !== "CREATED" && !needsRerun) return known;

  if (isThrottled(sessionId)) return known;

  // The state after the work, read again: "confirmed" is what the database says, not what this call hoped for.
  const latest = async (): Promise<PaymentConfirmationResult> => {
    const now = await prisma.orderSession.findUnique({
      where: { id: sessionId },
      select: { status: true, order: { select: { status: true } } },
    });
    return {
      status: now?.status ?? session.status,
      confirmed: REVENUE_STATUSES.includes(now?.order?.status ?? order.status),
    };
  };

  try {
    if (needsRerun) {
      if (!order.razorpayOrderId || !order.razorpayPaymentId) {
        logger.error(
          { sessionId, orderId: order.id },
          "Paid order has no Razorpay order or payment id, cannot run its paid steps again"
        );
        return { status: session.status, confirmed: true };
      }
      await applyCapturedPayment(
        { ...order, orderSession },
        order.razorpayOrderId,
        order.razorpayPaymentId,
        null
      );
      return await latest();
    }

    // order.status is CREATED from here on. No transaction is open while Razorpay is asked.
    if (!order.razorpayOrderId) {
      logger.error(
        { sessionId, orderId: order.id },
        "Order has no razorpayOrderId, cannot confirm its payment"
      );
      return { status: session.status, confirmed: false };
    }
    if (lookupsRunning >= MAX_LOOKUPS_AT_ONCE) {
      // No lookup was made, so the customer's next check must not be held back by the throttle.
      lastCheck.delete(sessionId);
      return { status: session.status, confirmed: false };
    }

    const expectedAmount = toSmallestUnit(
      order.amount.toNumber(),
      order.currency
    );
    const capturedOn = async (razorpayOrderId: string) => {
      const result = await withRazorpayTimeout(
        razorpay.orders.fetchPayments(razorpayOrderId)
      );
      const captured = (result.items ?? []).filter(
        (p) => p.status === "captured" && p.order_id === razorpayOrderId
      );
      const match = captured.find(
        (p) =>
          p.currency === order.currency &&
          Number(p.amount) === expectedAmount &&
          Number(p.amount_refunded ?? 0) === 0
      );
      const first = captured[0];
      if (!match && first) {
        // The customer paid but what Razorpay holds differs from the Order: never applied, so say so.
        logOnce(`mismatch:${sessionId}`, () =>
          logger.error(
            {
              sessionId,
              orderId: order.id,
              razorpayPaymentId: first.id,
              paidAmount: first.amount,
              paidCurrency: first.currency,
              refunded: first.amount_refunded,
              expectedAmount,
              expectedCurrency: order.currency,
            },
            "Captured payment on this order does not match the Order's amount, currency or refund state, not applied, admin follow-up needed"
          )
        );
      }
      return match;
    };

    lookupsRunning += 1;
    let payment: Awaited<ReturnType<typeof capturedOn>>;
    try {
      payment = await capturedOn(order.razorpayOrderId);
      if (!payment) await reportSupersededPayments(sessionId, order);
    } finally {
      lookupsRunning -= 1;
    }

    if (!payment) {
      return { status: session.status, confirmed: false };
    }

    logger.info(
      { sessionId, orderId: order.id, razorpayPaymentId: payment.id },
      "Captured payment found at Razorpay, confirming the order from the customer's page"
    );
    await applyCapturedPayment(
      { ...order, orderSession },
      order.razorpayOrderId,
      payment.id,
      null
    );
    return await latest();
  } catch (err) {
    // `err`, not `error`: see webhook.service.ts. The customer's page asks again.
    logger.error(
      { sessionId, orderId: order.id, err },
      "Payment confirmation failed, the customer's page will ask again"
    );
    return await latest().catch(() => ({
      status: session.status,
      confirmed: false,
    }));
  }
}
