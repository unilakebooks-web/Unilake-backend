// Aggregation behind the admin overview dashboard.
//
// Three exported functions, one per endpoint, deliberately NOT merged into a
// single "getEverything" call: the overview loads them as three independent
// TanStack queries so the ops-triage band paints without waiting on the chart,
// and one failing aggregate cannot blank the whole page.
//
// ------------------------------------------------------------------
// THE ONE RULE THAT RUNS THROUGH THIS FILE
// ------------------------------------------------------------------
// `range` filters MONEY AND VOLUME ONLY. Status counts, the needs-attention
// numbers and the recent-orders list are always live snapshots of right now.
//
// "₹48,500 in the last 30 days" is a statement about a period. "5 orders
// awaiting dimensions" is a statement about this moment — range-filtering it
// would hide a 40-day-old order that still has to be packed, which is exactly
// the order someone needs to be told about.
//
// ------------------------------------------------------------------
// NOTE ON PRISMA FEATURES
// ------------------------------------------------------------------
// This file introduces `groupBy`, aggregate `_sum`/`_count` and `$queryRaw` to
// a codebase that previously used none of them (only relation `_count`). The
// two raw queries exist for reasons that are structural, not stylistic:
//   - the chart needs day/month bucketing, which `groupBy` cannot express;
//   - `Order` has no `comicId` (it lives on `OrderSession`), so ranking comics
//     by order volume needs a real join.
// Everything else stays in the query builder.

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  ABANDONED_CHECKOUT_HOURS,
  ALL_ORDER_STATUSES,
  RANGE_DAYS,
  RECENT_ORDERS_LIMIT,
  REPORTING_TIMEZONE,
  REPORTING_UTC_OFFSET,
  REVENUE_STATUSES,
  STALE_TRACKING_DAYS,
  TOP_COMICS_LIMIT,
  type StatsRange,
} from "../config/stats.js";
import type { CoverType, OrderStatus } from "../generated/prisma/client.js";

// ============================================================
// SHARED HELPERS
// ============================================================

type Granularity = "day" | "month";

/**
 * Turns the validated range enum into the two things every query needs.
 *
 * `since` is IST MIDNIGHT of the first day in the window, not a rolling
 * `now - N×24h`. That distinction is load-bearing: a rolling window starts
 * mid-day, so "7 days" would span eight calendar days with a partial one at
 * each end — the chart would draw 8 bars under a "7 days" label, and the
 * revenue tile above it would count a different set of orders than the bars
 * below it. Anchoring to midnight makes the tile and the chart agree, and makes
 * both agree with what someone counting by hand would get.
 *
 * `since: null` for "all" rather than a sentinel date — callers omit the
 * `createdAt` clause entirely instead of comparing against the epoch, which
 * keeps the query plan clean and the intent obvious.
 */
function resolveRange(range: StatsRange): {
  since: Date | null;
  granularity: Granularity;
} {
  if (range === "all") {
    return { since: null, granularity: "month" };
  }

  const days = RANGE_DAYS[range];

  // days - 1 because the window is inclusive of today: "7d" is today plus the
  // six days before it, which is seven buckets.
  const since = new Date(
    istStartOfDay(new Date()).getTime() - (days - 1) * 24 * 60 * 60 * 1000
  );

  return { since, granularity: "day" };
}

/**
 * Money always leaves this service as a fixed-2 STRING, never a number.
 *
 * `Order.amount` is `Decimal(10,2)`. Routing it through JS floating point is
 * the classic way to ship a total that is wrong by a paisa and never errors,
 * so every value goes through decimal.js instead. `listAdminOrders` already
 * returns `amount` as a string; this keeps the whole admin surface consistent.
 *
 * Accepts whatever the driver hands back for a Postgres `numeric` — string,
 * number, or Decimal — because the raw queries and the query builder do not
 * agree on which one they return.
 */
function toMoneyString(
  value: Prisma.Decimal | string | number | null | undefined
): string {
  if (value === null || value === undefined) return "0.00";
  return new Prisma.Decimal(value).toFixed(2);
}

/**
 * The IST calendar day a given instant falls on, as "YYYY-MM-DD".
 *
 * `en-CA` is used purely because its short date format is ISO-ordered; the
 * locale is an implementation detail, the timezone is the part that matters.
 *
 * This must agree exactly with the `AT TIME ZONE` conversion in the timeseries
 * SQL — if the two ever drift, zero-filled buckets stop lining up with real
 * ones and days silently duplicate or vanish from the chart.
 */
function istDateKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * The UTC instant at which the IST calendar day containing `instant` began.
 *
 * Built by re-parsing the IST date key with an explicit fixed offset, which is
 * exact for a zone without DST — see REPORTING_UTC_OFFSET for why that holds
 * here and would not hold everywhere.
 */
function istStartOfDay(instant: Date): Date {
  return new Date(`${istDateKey(instant)}T00:00:00${REPORTING_UTC_OFFSET}`);
}

/**
 * Every "YYYY-MM-DD" key from `since` to now, inclusive, on IST boundaries.
 *
 * The cursor is anchored to UTC midnight of an IST-derived date string, so the
 * `.toISOString()` read-back is exact and never re-crosses a timezone. India
 * observes no DST, so stepping by a flat 24h can neither skip nor repeat a day.
 */
function enumerateDayKeys(since: Date, until: Date): string[] {
  const keys: string[] = [];

  let cursor = new Date(`${istDateKey(since)}T00:00:00Z`);
  const end = new Date(`${istDateKey(until)}T00:00:00Z`);

  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  return keys;
}

/**
 * Every month key from `fromKey` to the current IST month, inclusive, each
 * normalised to the 1st ("YYYY-MM-01") so it matches what `date_trunc('month')`
 * produces on the SQL side.
 *
 * Used only for the all-time range, where the start is taken from the earliest
 * bucket the query actually returned rather than from a `since` we do not have.
 * That avoids a separate MIN(createdAt) round trip.
 */
function enumerateMonthKeys(fromKey: string, until: Date): string[] {
  const keys: string[] = [];

  const [fromYear, fromMonth] = fromKey.split("-").map(Number) as [
    number,
    number,
  ];
  const [untilYear, untilMonth] = istDateKey(until).split("-").map(Number) as [
    number,
    number,
  ];

  let year = fromYear;
  let month = fromMonth;

  while (year < untilYear || (year === untilYear && month <= untilMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}-01`);

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
}

/**
 * `o.status IN (...)` for the raw queries.
 *
 * The cast to `::text` is load-bearing: `Order.status` is a Postgres enum type,
 * and the bind parameters arrive as plain strings. Comparing an enum column
 * against text without the cast is an operator-type error at execution time.
 */
const revenueStatusFilter = Prisma.sql`o.status::text IN (${Prisma.join(
  REVENUE_STATUSES
)})`;

// ============================================================
// 1. SUMMARY — KPIs, pipeline snapshot, triage, recent, top comics
// ============================================================

type RevenueBucket = {
  currency: string;
  total: string;
  orderCount: number;
  averageOrderValue: string;
};

type TopComicRawRow = {
  comicId: string;
  title: string;
  coverThumbnailUrls: string[];
  currency: string;
  orderCount: number;
  revenue: Prisma.Decimal | string | null;
};

/**
 * Top comics by paid-order volume for the range.
 *
 * Raw because `Order` carries no `comicId` — the link runs
 * orders → order_sessions → comics, and Prisma's `groupBy` can only group by
 * columns on the model being grouped.
 *
 * Grouped by currency as well as comic so a future second market never silently
 * adds INR and USD into one meaningless number. In practice that means a comic
 * sold in two currencies occupies two rows, which is the honest representation.
 *
 * `COUNT(*)::int` is deliberate: Postgres returns `bigint` for COUNT, which
 * arrives as a JS BigInt and would be serialised as a quoted string by the
 * global `BigInt.prototype.toJSON` patch in app.ts. The cast keeps it a number.
 */
async function getTopComics(since: Date | null) {
  const sinceFilter = since
    ? Prisma.sql`AND o."createdAt" >= ${since}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<TopComicRawRow[]>(Prisma.sql`
    SELECT
      c.id                   AS "comicId",
      c.title                AS "title",
      c."coverThumbnailUrls" AS "coverThumbnailUrls",
      o.currency             AS "currency",
      COUNT(*)::int          AS "orderCount",
      SUM(o.amount)          AS "revenue"
    FROM orders o
    JOIN order_sessions os ON os.id = o."orderSessionId"
    JOIN comics c          ON c.id  = os."comicId"
    WHERE ${revenueStatusFilter}
    ${sinceFilter}
    GROUP BY c.id, c.title, c."coverThumbnailUrls", o.currency
    ORDER BY "orderCount" DESC
    LIMIT ${TOP_COMICS_LIMIT}
  `);

  return rows.map((row) => ({
    comicId: row.comicId,
    title: row.title,
    // First element is the primary thumbnail per the multi-thumbnail rule.
    // The array can legitimately be empty on a draft comic.
    coverThumbnailUrl: row.coverThumbnailUrls[0] ?? null,
    currency: row.currency,
    orderCount: row.orderCount,
    revenue: toMoneyString(row.revenue),
  }));
}

export async function getStatsSummary(range: StatsRange) {
  const { since } = resolveRange(range);

  const now = new Date();
  const abandonedCutoff = new Date(
    now.getTime() - ABANDONED_CHECKOUT_HOURS * 60 * 60 * 1000
  );
  const staleTrackingCutoff = new Date(
    now.getTime() - STALE_TRACKING_DAYS * 24 * 60 * 60 * 1000
  );

  const paidInRange: Prisma.OrderWhereInput = {
    status: { in: REVENUE_STATUSES },
    ...(since ? { createdAt: { gte: since } } : {}),
  };

  const paidEver: Prisma.OrderWhereInput = {
    status: { in: REVENUE_STATUSES },
  };

  const [
    revenueGroups,
    lifetimeGroups,
    statusGroups,
    coverTypeGroups,
    awaitingDimensions,
    abandonedCheckouts,
    staleTracking,
    openFeedback,
    openEnquiries,
    recentOrderRows,
    topComics,
  ] = await Promise.all([
    // --- Money, range-filtered, split per currency -------------------------
    prisma.order.groupBy({
      by: ["currency"],
      where: paidInRange,
      _sum: { amount: true },
      _count: true,
    }),

    // --- Money, all time. Separate query rather than a second request so the
    //     tiles can show "last 30 days" over "all time" in one round trip.
    prisma.order.groupBy({
      by: ["currency"],
      where: paidEver,
      _sum: { amount: true },
      _count: true,
    }),

    // --- Pipeline snapshot. NOT range-filtered (see the file header).
    //     Also supplies two of the six needs-attention numbers for free:
    //     SHIPROCKET_FAILED and GENERATED.
    prisma.order.groupBy({
      by: ["status"],
      _count: true,
    }),

    // --- Hardcover vs softcover mix, range-filtered.
    prisma.order.groupBy({
      by: ["coverType"],
      where: paidInRange,
      _count: true,
    }),

    // --- Awaiting dimensions: Shiprocket accepted the order (READY_TO_SHIP)
    //     but no AWB has been generated, which is the admin's manual step.
    prisma.order.count({
      where: { status: "READY_TO_SHIP", awbNumber: null },
    }),

    // --- Abandoned checkouts: an Order row is created when the customer opens
    //     the Razorpay modal, so CREATED past the cutoff means they walked away.
    prisma.order.count({
      where: { status: "CREATED", createdAt: { lt: abandonedCutoff } },
    }),

    // --- Stale tracking. A SHIPPED order whose tracking has NEVER updated is
    //     the stalest case of all, so null counts alongside the age check
    //     rather than being excluded by it.
    prisma.order.count({
      where: {
        status: "SHIPPED",
        OR: [
          { trackingUpdatedAt: null },
          { trackingUpdatedAt: { lt: staleTrackingCutoff } },
        ],
      },
    }),

    prisma.feedback.count({ where: { status: "OPEN" } }),

    // --- Open contact enquiries. Counted separately from feedback: an
    //     unanswered enquiry is a customer waiting on a reply, which is a
    //     different (and more urgent) thing than an unread book suggestion.
    prisma.contactEnquiry.count({ where: { status: "OPEN" } }),

    // --- Recent orders. Always newest-first regardless of range: this is the
    //     "what just happened" list, not a report. Select mirrors
    //     listAdminOrders exactly so both screens render identical rows.
    prisma.order.findMany({
      take: RECENT_ORDERS_LIMIT,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        shippingName: true,
        amount: true,
        currency: true,
        status: true,
        orderSession: {
          select: {
            childName: true,
            comic: { select: { title: true } },
          },
        },
      },
    }),

    getTopComics(since),
  ]);

  // --- Revenue, per currency -----------------------------------------------
  //
  // AOV divides through decimal.js rather than JS numbers, for the same reason
  // the totals do. A currency group only exists here if it has at least one
  // row, so the divisor can never be zero — the guard is defence in depth.
  const revenue: RevenueBucket[] = revenueGroups.map((group) => {
    const total = group._sum.amount ?? new Prisma.Decimal(0);
    const orderCount = group._count;

    return {
      currency: group.currency,
      total: toMoneyString(total),
      orderCount,
      averageOrderValue:
        orderCount > 0 ? total.div(orderCount).toFixed(2) : "0.00",
    };
  });

  // --- Lifetime revenue ----------------------------------------------------
  //
  // Same shape as `revenue` minus the AOV, which only makes sense against a
  // period. This is the "all time" line under each range-filtered tile.
  const lifetime = lifetimeGroups.map((group) => ({
    currency: group.currency,
    total: toMoneyString(group._sum.amount),
    orderCount: group._count,
  }));

  // --- Pipeline snapshot ---------------------------------------------------
  //
  // Seeded with every status at zero first. `groupBy` omits empty groups, so
  // without the seed the response would be missing keys the frontend indexes
  // into directly.
  const ordersByStatus = Object.fromEntries(
    ALL_ORDER_STATUSES.map((status) => [status, 0])
  ) as Record<OrderStatus, number>;

  for (const group of statusGroups) {
    ordersByStatus[group.status] = group._count;
  }

  // --- Cover type split ----------------------------------------------------
  //
  // `Order.coverType` is non-nullable, so both keys are seeded and overlaid the
  // same way as the status map.
  const coverTypeSplit: Record<CoverType, number> = {
    HARDCOVER: 0,
    SOFTCOVER: 0,
  };

  for (const group of coverTypeGroups) {
    coverTypeSplit[group.coverType] = group._count;
  }

  return {
    range,

    revenue,
    lifetime,

    ordersByStatus,
    coverTypeSplit,

    needsAttention: {
      // Both of these are read off the pipeline snapshot rather than costing
      // their own COUNT queries.
      shiprocketFailed: ordersByStatus.SHIPROCKET_FAILED,
      awaitingCustomerSelection: ordersByStatus.GENERATED,

      awaitingDimensions,
      abandonedCheckouts,
      staleTracking,
      openFeedback,
      openEnquiries,
    },

    topComics,

    recentOrders: recentOrderRows.map((order) => ({
      id: order.id,
      createdAt: order.createdAt,
      customerName: order.shippingName,
      childName: order.orderSession.childName,
      comicTitle: order.orderSession.comic.title,
      amount: order.amount.toString(),
      currency: order.currency,
      status: order.status,
    })),
  };
}

// ============================================================
// 2. TIMESERIES — the chart
// ============================================================

type TimeseriesRawRow = {
  bucket: string;
  currency: string;
  orders: number;
  revenue: Prisma.Decimal | string | null;
};

export async function getStatsTimeseries(range: StatsRange) {
  const { since, granularity } = resolveRange(range);

  const sinceFilter = since
    ? Prisma.sql`AND o."createdAt" >= ${since}`
    : Prisma.empty;

  // Branched on the validated enum, never interpolated from input. `date_trunc`
  // takes its unit as text, so this could technically be a bind parameter —
  // two literal fragments keep it impossible to get wrong by accident.
  const truncUnit =
    granularity === "month" ? Prisma.sql`'month'` : Prisma.sql`'day'`;

  // The bucket is formatted to text IN SQL rather than returned as a timestamp.
  //
  // `AT TIME ZONE` yields a `timestamp without time zone` holding IST wall-clock
  // time, and node-postgres parses that kind of value using the *Node process's*
  // local timezone — so reading it back as a JS Date would re-shift it by
  // whatever the server happens to be set to. `to_char` sidesteps the driver's
  // date handling completely and hands back the exact string the chart needs.
  const rows = await prisma.$queryRaw<TimeseriesRawRow[]>(Prisma.sql`
    SELECT
      to_char(
        date_trunc(${truncUnit}, o."createdAt" AT TIME ZONE ${REPORTING_TIMEZONE}),
        'YYYY-MM-DD'
      )               AS "bucket",
      o.currency      AS "currency",
      COUNT(*)::int   AS "orders",
      SUM(o.amount)   AS "revenue"
    FROM orders o
    WHERE ${revenueStatusFilter}
    ${sinceFilter}
    GROUP BY "bucket", o.currency
    ORDER BY "bucket" ASC
  `);

  // --- Zero-fill -----------------------------------------------------------
  //
  // A bucket with no orders produces no row. Handing that straight to the chart
  // draws a gap where it should draw a zero, which reads as missing data rather
  // than as a quiet day.
  //
  // With no rows at all there is nothing to fill and no currency to fill it
  // for — an empty series is the honest answer, and the frontend renders its
  // "not enough data yet" state.
  if (rows.length === 0) {
    return { range, granularity, points: [] };
  }

  const now = new Date();

  const bucketKeys =
    granularity === "month"
      ? // All-time: start from the earliest bucket the query returned rather
        // than paying for a separate MIN(createdAt) round trip. Rows are
        // already ordered ascending.
        enumerateMonthKeys(rows[0]!.bucket, now)
      : enumerateDayKeys(since!, now);

  const currencies = [...new Set(rows.map((row) => row.currency))];

  const byKey = new Map(
    rows.map((row) => [`${row.bucket}|${row.currency}`, row])
  );

  const points = currencies.flatMap((currency) =>
    bucketKeys.map((bucket) => {
      const row = byKey.get(`${bucket}|${currency}`);

      return {
        date: bucket,
        currency,
        orders: row?.orders ?? 0,
        revenue: toMoneyString(row?.revenue),
      };
    })
  );

  return { range, granularity, points };
}

// ============================================================
// 3. CONTENT HEALTH — is the storefront correctly configured right now
// ============================================================

/**
 * Takes no range: this is always a statement about the present.
 *
 * Every check is a plain count. The panel's job is to make a misconfigured
 * storefront visible from the dashboard instead of from a customer complaint —
 * particularly the How It Works rule, whose real publish condition is stricter
 * than the `isActive` flag an admin sees in its own editor.
 */
export async function getContentHealth() {
  const [
    comicStatusGroups,
    publishedMissingPricing,
    publishedWithIncompleteMrp,
    activeHeroImages,
    activeAnnouncements,
    howItWorks,
    activeCustomerReviews,
    activeGoogleReviews,
    activeTeamMembers,
    faqGroups,
    publishedBlogs,
    sitePages,
    siteSetting,
    activeCountries,
  ] = await Promise.all([
    prisma.comic.groupBy({ by: ["status"], _count: true }),

    // --- Pricing completeness, simplified on purpose ------------------------
    //
    // The admin panel's PrePublishChecklist runs the full matrix (every active
    // country × both cover types × an MRP greater than zero). Reproducing that
    // here would mean a nested query per comic for a number nobody drills into.
    //
    // These two counts catch the failure modes that actually reach production:
    // a published comic with no pricing at all, and one carrying a rule from
    // before the `mrp` column existed — which makes the storefront silently
    // drop the strike-through price.
    prisma.comic.count({
      where: { status: "PUBLISHED", pricingRules: { none: {} } },
    }),
    prisma.comic.count({
      where: {
        status: "PUBLISHED",
        pricingRules: { some: { OR: [{ mrp: null }, { mrp: { lte: 0 } }] } },
      },
    }),

    prisma.heroImage.count({ where: { isActive: true } }),
    prisma.announcementBar.count({ where: { isActive: true } }),

    // Singleton, found the same way getPublicHowItWorks finds it. The
    // deterministic orderBy matters: if duplicate rows ever exist, this check
    // and the public endpoint must agree on which one is authoritative.
    prisma.howItWorks.findFirst({
      orderBy: { createdAt: "asc" },
      select: { isActive: true, videoUrl: true, steps: true },
    }),

    prisma.customerReview.count({ where: { isActive: true } }),
    prisma.googleReview.count({ where: { isActive: true } }),
    prisma.teamMember.count({ where: { isActive: true } }),

    prisma.faq.groupBy({
      by: ["placement"],
      where: { isActive: true },
      _count: true,
    }),

    prisma.blog.count({ where: { isActive: true } }),

    prisma.sitePage.findMany({ select: { slug: true, isActive: true } }),

    prisma.siteSetting.findUnique({
      where: { id: "singleton" },
      select: { email: true, phone: true },
    }),

    prisma.country.count({ where: { isActive: true } }),
  ]);

  const comicCounts = { published: 0, draft: 0, unpublished: 0 };

  for (const group of comicStatusGroups) {
    if (group.status === "PUBLISHED") comicCounts.published = group._count;
    else if (group.status === "DRAFT") comicCounts.draft = group._count;
    else if (group.status === "UNPUBLISHED")
      comicCounts.unpublished = group._count;
    // PUBLISHING is a transient job state and is deliberately not surfaced.
  }

  // The real public readiness rule from getPublicHowItWorks: active is not
  // enough on its own — a section with no video or no steps returns null to the
  // homepage no matter what the flag says.
  const howItWorksReady =
    !!howItWorks &&
    howItWorks.isActive &&
    !!howItWorks.videoUrl &&
    Array.isArray(howItWorks.steps) &&
    howItWorks.steps.length > 0;

  const faqCounts = { home: 0, comic: 0 };

  for (const group of faqGroups) {
    if (group.placement === "HOME") faqCounts.home = group._count;
    else if (group.placement === "COMIC") faqCounts.comic = group._count;
  }

  // A slug with no row at all reads the same as an unpublished one — in both
  // cases the public endpoint 404s and the page is not live.
  const isSitePageLive = (slug: "PRIVACY" | "TERMS" | "REFUND") =>
    sitePages.some((page) => page.slug === slug && page.isActive);

  return {
    comics: {
      ...comicCounts,
      publishedMissingPricing,
      publishedWithIncompleteMrp,
    },

    homepage: {
      activeHeroImages,
      activeAnnouncements,
      howItWorksReady,
      activeCustomerReviews,
      activeGoogleReviews,
      activeTeamMembers,
    },

    content: {
      activeFaqsHome: faqCounts.home,
      activeFaqsComic: faqCounts.comic,
      publishedBlogs,
    },

    legal: {
      privacyActive: isSitePageLive("PRIVACY"),
      termsActive: isSitePageLive("TERMS"),
      refundActive: isSitePageLive("REFUND"),
    },

    settings: {
      siteSettingsSaved: !!siteSetting,
      contactEmailSet: !!siteSetting?.email,
      contactPhoneSet: !!siteSetting?.phone,
    },

    countries: {
      active: activeCountries,
    },
  };
}
