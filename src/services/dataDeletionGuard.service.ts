import { prisma } from "../lib/prisma.js";
import { razorpay } from "../lib/razorpay.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";
import {
  PAYMENT_IN_FLIGHT_MS,
  PAYMENT_RECENT_WINDOW_MS,
  RAZORPAY_CALL_TIMEOUT_MS,
} from "../config/dataDeletion.js";

// The money guard of R1 (feature 6, plan section 1): an unpaid preview is deleted only when nothing says a
// payment happened or is happening. This file holds the two parts that look outside the order row: events that
// Razorpay sent (stored in webhook_events, linked to the order or not) and Razorpay itself, read-only.

/** What the guard needs of Razorpay: two read-only calls. Tests pass a stub. */
export interface RazorpayReader {
  fetchPayments(razorpayOrderId: string): Promise<unknown>;
  fetchOrder(razorpayOrderId: string): Promise<unknown>;
}

export const realRazorpayReader: RazorpayReader = {
  fetchPayments: (id) => razorpay.orders.fetchPayments(id),
  fetchOrder: (id) => razorpay.orders.fetch(id),
};

/** Event kinds that prove a payment: a failed attempt never blocks. */
export const PAYMENT_EVENT_TYPES = [
  "payment.captured",
  "payment.authorized",
  "order.paid",
];

export interface RazorpayBudget {
  left: number;
}

export type GuardVerdict =
  | { kind: "clear" }
  | { kind: "blocked"; reason: string }
  | { kind: "skip"; reason: string };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("razorpay_timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

interface RazorpayPayment {
  status?: unknown;
  created_at?: unknown;
}

/**
 * Judges the payments Razorpay lists for one Razorpay order (an allowlist): no payments, or only old failed ones,
 * is clear; anything else blocks. `created` older than the window needs the order's own status (`needsOrderStatus`).
 */
export function evaluatePayments(
  payments: RazorpayPayment[],
  now: Date,
  pastCap: boolean
):
  | { kind: "clear" | "needs_order_status" }
  | { kind: "blocked"; reason: string } {
  let needsOrderStatus = false;
  for (const payment of payments) {
    const status =
      typeof payment.status === "string" ? payment.status : "unknown";
    const createdMs =
      typeof payment.created_at === "number" ? payment.created_at * 1000 : NaN;
    const ageMs = Number.isFinite(createdMs) ? now.getTime() - createdMs : NaN;
    if (status === "failed") {
      if (!Number.isFinite(ageMs))
        return { kind: "blocked", reason: "payment_failed_unknown_age" };
      // A declined attempt may be retried: it holds the order for 2 days, but never past the 3-day cap.
      if (!pastCap && ageMs < PAYMENT_RECENT_WINDOW_MS)
        return { kind: "blocked", reason: "payment_failed_recent" };
      continue;
    }
    if (status === "created") {
      if (!Number.isFinite(ageMs))
        return { kind: "blocked", reason: "payment_created_unknown_age" };
      if (ageMs < PAYMENT_IN_FLIGHT_MS)
        return { kind: "blocked", reason: "payment_in_flight" };
      if (!pastCap && ageMs < PAYMENT_RECENT_WINDOW_MS)
        return { kind: "blocked", reason: "payment_created_recent" };
      needsOrderStatus = true;
      continue;
    }
    // captured, authorized, refunded or a status we do not know: never delete.
    return { kind: "blocked", reason: `payment_${status}` };
  }
  return { kind: needsOrderStatus ? "needs_order_status" : "clear" };
}

/**
 * Asks Razorpay about the current and every superseded Razorpay order of an order. Any error, timeout, malformed
 * answer or exhausted call budget skips the item (never deletes on a doubt); an unknown order id blocks and is listed.
 */
export async function checkRazorpay(
  order: {
    razorpayOrderId: string | null;
    supersededRazorpayOrderIds: string[];
  },
  now: Date,
  pastCap: boolean,
  budget: RazorpayBudget,
  reader: RazorpayReader
): Promise<GuardVerdict> {
  if (!order.razorpayOrderId)
    return { kind: "skip", reason: "no_razorpay_order_id" };
  const ids = [order.razorpayOrderId, ...order.supersededRazorpayOrderIds];
  for (const id of ids) {
    if (budget.left <= 0) return { kind: "skip", reason: "not_checked" };
    budget.left -= 1;
    let answer: unknown;
    try {
      answer = await withTimeout(
        reader.fetchPayments(id),
        RAZORPAY_CALL_TIMEOUT_MS
      );
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if (status === 400 || status === 404) {
        return { kind: "blocked", reason: "unknown_order" };
      }
      logger.warn(
        {
          razorpayOrderId: id,
          statusCode: status,
          errorName: (error as Error)?.name,
        },
        "[Data deletion] Razorpay payments read failed"
      );
      return { kind: "skip", reason: "razorpay_error" };
    }
    const collection = answer as {
      entity?: unknown;
      count?: unknown;
      items?: unknown;
    };
    if (
      !collection ||
      collection.entity !== "collection" ||
      !Array.isArray(collection.items) ||
      collection.count !== collection.items.length
    ) {
      return { kind: "skip", reason: "malformed_answer" };
    }
    const evaluated = evaluatePayments(
      collection.items as RazorpayPayment[],
      now,
      pastCap
    );
    if (evaluated.kind === "blocked") return evaluated;
    if (evaluated.kind === "needs_order_status") {
      if (budget.left <= 0) return { kind: "skip", reason: "not_checked" };
      budget.left -= 1;
      try {
        const rzpOrder = (await withTimeout(
          reader.fetchOrder(id),
          RAZORPAY_CALL_TIMEOUT_MS
        )) as { status?: unknown };
        if (typeof rzpOrder?.status !== "string") {
          return { kind: "skip", reason: "malformed_answer" };
        }
        if (rzpOrder.status === "paid")
          return { kind: "blocked", reason: "razorpay_order_paid" };
      } catch (error) {
        logger.warn(
          { razorpayOrderId: id, errorName: (error as Error)?.name },
          "[Data deletion] Razorpay order read failed"
        );
        return { kind: "skip", reason: "razorpay_error" };
      }
    }
  }
  return { kind: "clear" };
}

/**
 * Of the given Razorpay order ids, those named by a stored payment event that is not linked to an order (the webhook
 * links only `payment.captured`). The order id sits at two payload paths. One query per run, for the candidates only.
 */
export async function eventHitRazorpayIds(
  razorpayIds: string[],
  since?: Date,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Set<string>> {
  if (razorpayIds.length === 0) return new Set();
  const rows = await client.$queryRaw<{ rid: string | null }[]>`
    SELECT DISTINCT COALESCE(
      "payloadJson"->'payload'->'payment'->'entity'->>'order_id',
      "payloadJson"->'payload'->'order'->'entity'->>'id'
    ) AS rid
    FROM "webhook_events"
    WHERE "source" = 'razorpay'
      AND "eventType" = ANY(${PAYMENT_EVENT_TYPES}::text[])
      AND COALESCE(
        "payloadJson"->'payload'->'payment'->'entity'->>'order_id',
        "payloadJson"->'payload'->'order'->'entity'->>'id'
      ) = ANY(${razorpayIds}::text[])
      ${since ? Prisma.sql`AND "processedAt" >= ${since}` : Prisma.sql``}
  `;
  return new Set(rows.map((row) => row.rid).filter((v): v is string => !!v));
}

/** Linked payment events of an order (inside the claim's transaction when `tx` is given). */
export async function linkedPaymentEventCount(
  orderId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<number> {
  return tx.webhookEvent.count({
    where: { orderId, eventType: { in: PAYMENT_EVENT_TYPES } },
  });
}

/** Records a verdict for an order or session ("clear" or a blocking reason). */
export async function recordVerdict(
  subjectId: string,
  reason: string,
  now: Date
): Promise<void> {
  await prisma.deletionBlock.upsert({
    where: { subjectId },
    create: { subjectId, reason, checkedAt: now },
    update: { reason, checkedAt: now },
  });
}

/** True when a clear verdict is at most `maxAgeMs` old (D-096: 10 minutes for a claim). */
export async function hasFreshClearVerdict(
  subjectId: string,
  now: Date,
  maxAgeMs: number
): Promise<boolean> {
  const row = await prisma.deletionBlock.findUnique({ where: { subjectId } });
  return (
    !!row &&
    row.reason === "clear" &&
    now.getTime() - row.checkedAt.getTime() <= maxAgeMs
  );
}
