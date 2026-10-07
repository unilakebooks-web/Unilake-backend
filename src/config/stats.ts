// Tunables for the admin overview dashboard (GET /api/admin/stats/*).
//
// Everything the stats endpoints treat as a policy decision lives here rather
// than inline in the service, for the same reason generation.ts and shipping.ts
// exist: the numbers below are business calls, not implementation details, and
// changing one should never mean reading an aggregation query to find it.

import type { OrderStatus } from "../generated/prisma/client.js";

// ============================================================
// REPORTING TIMEZONE
// ============================================================
//
// Every date bucket on the overview chart is cut on IST day boundaries, not
// UTC. The business and effectively all of its customers are in India, so an
// order placed at 01:00 IST belongs to that day as a human would count it —
// under UTC it would silently land on the previous day's bar and the chart
// would disagree with anything counted by hand.
//
// Deliberately a constant and NOT an env var: `env.ts` hard-exits on 26
// required variables already, and a reporting timezone that can be misconfigured
// in one environment produces numbers that are wrong but never error.
//
// Consumed two ways, both of which must agree:
//   1. Postgres — `AT TIME ZONE` inside the timeseries query.
//   2. Node — `Intl.DateTimeFormat` when zero-filling empty buckets.
export const REPORTING_TIMEZONE = "Asia/Kolkata";

// The same offset as a fixed literal, used to resolve IST midnight to a real
// UTC instant when computing range boundaries.
//
// Safe to hardcode ONLY because India observes no daylight saving and has held
// UTC+05:30 since 1945 — a zone with DST could not be expressed this way.
// If REPORTING_TIMEZONE ever changes, this must change with it.
export const REPORTING_UTC_OFFSET = "+05:30";

// ============================================================
// WHAT COUNTS AS REVENUE
// ============================================================
//
// An Order row is created at checkout *initiation*, before any money moves, so
// `CREATED` means "someone opened the Razorpay modal" — counting it would
// inflate revenue with abandoned carts. `CANCELLED` is money that came back.
//
// `SHIPROCKET_FAILED` IS included: the customer paid and the payment stands;
// the shipment failing is an ops problem on our side, not a reversal.
export const REVENUE_STATUSES: OrderStatus[] = [
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
];

// Every OrderStatus value, in pipeline order.
//
// Used to seed the `ordersByStatus` map with zeros before overlaying the real
// counts. Prisma's `groupBy` only returns groups that actually have rows, so
// without this seed a status with no orders is simply absent from the response
// and the frontend reads `undefined` where it expects a number.
//
// Order matters — the overview renders the status breakdown in this sequence.
export const ALL_ORDER_STATUSES: OrderStatus[] = [
  "CREATED",
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

// ============================================================
// DATE RANGE
// ============================================================
//
// Fixed presets rather than an arbitrary from/to pair: it keeps the query
// surface to one validated enum, and there is no custom-range UI to feed it.
export const STATS_RANGES = ["7d", "30d", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const DEFAULT_STATS_RANGE: StatsRange = "30d";

// Day-resolution buckets stay readable up to ~90 points; all-time would grow
// without bound, so it switches to months. The chosen unit travels back in the
// response as `granularity` so the frontend labels the axis correctly instead
// of guessing from the point count.
export const RANGE_DAYS: Record<Exclude<StatsRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
};

// ============================================================
// "NEEDS ATTENTION" THRESHOLDS
// ============================================================
//
// Both of these describe an order that is not technically broken but has sat
// still long enough to be worth a human look.

// A `CREATED` order older than this never got paid — the customer opened
// Razorpay and walked away. Razorpay itself expires an unused order after 15
// minutes, so anything past a day is certainly abandoned rather than in flight.
export const ABANDONED_CHECKOUT_HOURS = 24;

// A `SHIPPED` order whose tracking has not moved in this long is either stuck
// with the courier or not being polled. An order shipped with tracking that has
// *never* updated counts as stale too — see the null handling in the service.
export const STALE_TRACKING_DAYS = 5;

// ============================================================
// LIST SIZES
// ============================================================
//
// Both lists are glanceable summaries on a dashboard, not browsable tables —
// the full views live at /admin/orders and /admin/comics.
export const RECENT_ORDERS_LIMIT = 6;
export const TOP_COMICS_LIMIT = 5;
