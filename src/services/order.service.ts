import { prisma } from "../lib/prisma.js";
import { NotFoundError, ForbiddenError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import {
  toPublicStatus,
  type PublicOrderStatus,
} from "../utils/orderStatusMapping.js";
import type { ListAdminOrdersQueryInput } from "../validators/order.schema.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * List all orders belonging to a user, most recent first.
 * Called from the customer-facing "My Orders" page.
 *
 * We return a curated shape — no razorpayPaymentId, no webhook internals,
 * no admin-only fields like shiprocketOrderId or awbNumber. Just what the
 * customer needs to see on the list card.
 */

/**
 * The generated cover for the customer's own order views, plus the page's
 * real pixel size so the card can draw it at its true shape (landscape or
 * portrait) instead of cropping it into a fixed frame.
 */
export type UserGeneratedCover = GeneratedCover & {
  /** Page 1's artwork size. Null only if the page has no artwork dimensions. */
  width: number | null;
  height: number | null;
};

/**
 * Generated covers for a batch of sessions, in ONE query — same rule as the
 * admin screens (pickGeneratedCover): the variant that was sent to print wins,
 * otherwise page 1's newest finished variant. Sessions with nothing generated
 * are simply absent from the map; the client falls back to the marketing
 * thumbnail.
 */
async function getUserGeneratedCovers(
  sessionIds: string[]
): Promise<Map<string, UserGeneratedCover>> {
  const covers = new Map<string, UserGeneratedCover>();
  if (sessionIds.length === 0) return covers;

  const rows = await prisma.pageVersion.findMany({
    where: {
      orderSessionId: { in: sessionIds },
      page: { pageNumber: COVER_PAGE_NUMBER },
      status: "SD_READY",
    },
    select: {
      orderSessionId: true,
      variantIndex: true,
      isSelected: true,
      displayImageUrl: true,
      finalImageUrl: true,
      page: { select: { artworkWidth: true, artworkHeight: true } },
    },
  });

  const rowsBySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = rowsBySession.get(row.orderSessionId);
    if (existing) {
      existing.push(row);
    } else {
      rowsBySession.set(row.orderSessionId, [row]);
    }
  }

  for (const [sessionId, sessionRows] of rowsBySession) {
    const cover = pickGeneratedCover(sessionRows);
    if (!cover) continue;

    // Every candidate is page 1 of the same comic, so any row's page carries
    // the right dimensions.
    const page = sessionRows[0]!.page;
    covers.set(sessionId, {
      ...cover,
      width: page.artworkWidth,
      height: page.artworkHeight,
    });
  }

  return covers;
}

export async function listUserOrders(userId: string) {
  const orders = await prisma.order.findMany({
    where: {
      orderSession: { userId },
      // Abandoned checkouts drop off the customer's list once their session's
      // expiry window has passed: an unpaid (CREATED) order whose session is past
      // expiresAt. Paid orders always show, however old.
      //
      // List-only, by decision — nothing is written. AWAITING_PAYMENT sessions
      // stay exempt from expiry (EXPIRY_EXEMPT_STATUSES), so a customer who
      // still pays through an old Razorpay window is processed normally by the
      // webhook and the order reappears here as paid. The detail endpoint and
      // the admin list are deliberately unfiltered.
      NOT: {
        status: "CREATED",
        orderSession: { expiresAt: { lt: new Date() } },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      amount: true,
      currency: true,
      coverType: true,
      createdAt: true,
      trackingStatus: true,
      orderSession: {
        select: {
          id: true,
          comic: {
            select: { id: true, title: true, coverThumbnailUrls: true },
          },
        },
      },
    },
  });
  const covers = await getUserGeneratedCovers(
    orders.map((order) => order.orderSession.id)
  );

  return orders.map((order) => ({
    id: order.id,
    sessionId: order.orderSession.id,
    comic: order.orderSession.comic,
    // Null when nothing is generated yet — the client shows the comic's
    // marketing thumbnail instead.
    generatedCover: covers.get(order.orderSession.id) ?? null,
    coverType: order.coverType,
    amount: order.amount.toString(),
    currency: order.currency,
    publicStatus: toPublicStatus(order.status),
    trackingStatus: order.trackingStatus,
    createdAt: order.createdAt,
  }));
}

/**
 * Get a single order by id, with ownership check.
 * Returns the customer-facing shape — includes shipping snapshot and PDF url
 * (needed for "Reprint" / "Download PDF"), excludes admin/gateway internals.
 */

export async function getUserOrder(orderId: string, userId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      orderSession: {
        select: {
          id: true,
          userId: true,
          comic: {
            select: { id: true, title: true, coverThumbnailUrls: true },
          },
        },
      },
    },
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  if (order.orderSession.userId !== userId) {
    logger.warn(
      { orderId, userId, ownerUserId: order.orderSession.userId },
      "Ownership check failed on order fetch"
    );
    throw new ForbiddenError("You do not have permission to view this order");
  }

  const covers = await getUserGeneratedCovers([order.orderSession.id]);

  return {
    id: order.id,
    sessionId: order.orderSession.id,
    comic: order.orderSession.comic,
    generatedCover: covers.get(order.orderSession.id) ?? null,
    coverType: order.coverType,
    amount: order.amount.toString(),
    currency: order.currency,
    publicStatus: toPublicStatus(order.status),
    shipping: {
      name: order.shippingName,
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      city: order.shippingCity,
      state: order.shippingState,
      zip: order.shippingZip,
      country: order.shippingCountry,
      phone: order.shippingPhone,
    },
    pdfDownloadUrl: order.pdfDownloadUrl,
    pdfDownloadExpiry: order.pdfDownloadExpiry,
    trackingStatus: order.trackingStatus,
    courierName: order.courierName,
    awbNumber: order.awbNumber,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

// ============================================================
// USER TRACKING (Section 6)
// ============================================================
//
// Returns the customer's view of their order's shipment status.
// Deliberately narrow: only fields safe for user consumption.
//
// Raw `trackingStatus` (Shiprocket's inconsistent-casing text) is admin-only
// per the Aug 29 decision — do NOT add it here. Admin endpoints (Section 7)
// return it separately alongside the mapped status.
//
// Ownership: Order has no userId of its own; it lives on OrderSession.
// A null userId (anonymous session that never attached a login) also fails
// the ownership check — treated as "not yours" rather than "no owner."

export type UserOrderTracking = {
  status: PublicOrderStatus;
  courierName: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  pickupScheduledDate: Date | null;
  trackingUpdatedAt: Date | null;
};

export async function getTrackingForUser(
  orderId: string,
  userId: string
): Promise<UserOrderTracking> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      courierName: true,
      shippedAt: true,
      deliveredAt: true,
      pickupScheduledDate: true,
      trackingUpdatedAt: true,
      orderSession: {
        select: { userId: true },
      },
    },
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  if (!order.orderSession.userId || order.orderSession.userId !== userId) {
    throw new ForbiddenError("You do not have permission to view this order");
  }

  return {
    status: toPublicStatus(order.status),
    courierName: order.courierName,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    pickupScheduledDate: order.pickupScheduledDate,
    trackingUpdatedAt: order.trackingUpdatedAt,
  };
}

// ============================================================
// GENERATED COVER (shared by the admin list + detail endpoints)
// ============================================================
//
// Both admin endpoints previously showed Comic.coverThumbnailUrls — the
// MARKETING thumbnail of the template, identical for every customer who
// ordered that comic. What an admin actually needs is the personalised page
// that this specific child's book opens on, which lives on PageVersion.

/**
 * Page 1 is the front cover of every comic. There is no isCover flag on Page —
 * the cover is positional — so this constant is the single place that encodes
 * it. Change it here and both endpoints follow.
 */
const COVER_PAGE_NUMBER = 1;

type CoverCandidate = {
  variantIndex: number;
  isSelected: boolean;
  displayImageUrl: string | null;
  finalImageUrl: string | null;
};

export type GeneratedCover = {
  imageUrl: string;
  variantIndex: number;
  isSelected: boolean;
};

/**
 * Picks which generated page-1 variant represents this order's cover.
 *
 * `isSelected` wins outright: sendToPrint writes it on exactly the variants
 * that went into the PDF, so for a CONFIRMED order it IS the printed cover.
 * Before send-to-print nothing is selected at all, so the newest variant is the
 * closest available truth — it is what the customer is looking at in their own
 * preview, and what they are most likely to pick.
 *
 * Deliberately does NOT rely on the caller's ordering. The two call sites build
 * their candidate lists from different queries, and a positional assumption
 * here would silently pick the wrong variant if either query's orderBy changed.
 *
 * Returns null when nothing is generated yet — a legitimate state for an order
 * at CREATED, or one whose page-1 generation final-failed. Callers render a
 * placeholder rather than falling back to the template thumbnail, which would
 * look like a generated cover and mislead whoever is checking what shipped.
 */
function pickGeneratedCover(candidates: CoverCandidate[]): GeneratedCover | null {
  if (candidates.length === 0) return null;

  const chosen =
    candidates.find((c) => c.isSelected) ??
    candidates.reduce((best, c) => (c.variantIndex > best.variantIndex ? c : best));

  // displayImageUrl is the ~250KB webp derivative and is what a browser should
  // render. finalImageUrl (the 4–5MB print master) is only reached on rows
  // written before the derivative existed, or where building it failed —
  // buildAndUploadDisplayImage is best-effort by design and returns null rather
  // than failing the generation job.
  const imageUrl = chosen.displayImageUrl ?? chosen.finalImageUrl;
  if (!imageUrl) return null;

  return {
    imageUrl,
    variantIndex: chosen.variantIndex,
    isSelected: chosen.isSelected,
  };
}

// ============================================================
// ADMIN ORDER LIST (Section 7 — endpoint 1 of 8)
// ============================================================
//
// Paginated + searchable + filterable list of ALL orders for the admin
// panel. Row shape is deliberately narrow — enough to render the table
// row and decide which order to open. Full detail comes from the
// per-order endpoint (endpoint 2 of 8).
//
// Search is case-insensitive and matches across:
//   Order:         id, shippingName, notificationEmail, shippingPhone, awbNumber
//   OrderSession:  childName
//   Comic:         title
// The nested-relation OR clauses cost joins per search; acceptable at
// current scale, revisit in Section 8 if the admin table gets slow.

export async function listAdminOrders(filters: ListAdminOrdersQueryInput) {
  const where: Prisma.OrderWhereInput = {};

  if (filters.status !== undefined) {
    where.status = filters.status;
  }

  if (filters.search !== undefined) {
    const q = filters.search; // already trimmed + min-length checked in Zod
    where.OR = [
      { id: { contains: q, mode: "insensitive" } },
      { shippingName: { contains: q, mode: "insensitive" } },
      { notificationEmail: { contains: q, mode: "insensitive" } },
      { shippingPhone: { contains: q, mode: "insensitive" } },
      { awbNumber: { contains: q, mode: "insensitive" } },
      { orderSession: { childName: { contains: q, mode: "insensitive" } } },
      {
        orderSession: {
          comic: { title: { contains: q, mode: "insensitive" } },
        },
      },
    ];
  }

  const skip = (filters.page - 1) * filters.pageSize;
  const take = filters.pageSize;

  // Fire the two queries in parallel — count needs the same `where` as the list.
  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      skip,
      take,
      orderBy: { [filters.sortBy]: filters.sortOrder },
      select: {
        id: true,
        createdAt: true,
        shippingName: true,
        notificationEmail: true,
        shippingPhone: true,
        amount: true,
        currency: true,
        status: true,
        trackingStatus: true,
        awbNumber: true,
        courierName: true,
        shippedAt: true,
        deliveredAt: true,
        orderSession: {
          select: {
            // Needed to key the batched cover lookup below — not rendered.
            id: true,
            childName: true,
            comic: { select: { title: true } },
          },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  // Generated covers, in ONE batched round trip.
  //
  // These cannot be nested into the row select above without Prisma issuing a
  // per-row subquery, so they are fetched separately and joined in memory. Cost
  // is one extra query per PAGE of results regardless of pageSize — deliberately
  // not an N+1. Bounded by pageSize × the per-page variant cap.
  //
  // Runs after the transaction because the session ids only exist once it has
  // resolved.
  const sessionIds = orders.map((o) => o.orderSession.id);

  const coverRows = sessionIds.length
    ? await prisma.pageVersion.findMany({
        where: {
          orderSessionId: { in: sessionIds },
          page: { pageNumber: COVER_PAGE_NUMBER },
          status: "SD_READY",
        },
        select: {
          orderSessionId: true,
          variantIndex: true,
          isSelected: true,
          displayImageUrl: true,
          finalImageUrl: true,
        },
      })
    : [];

  // Group by session so pickGeneratedCover sees one order's variants at a time.
  // Building the map once is O(n); filtering per row below would be O(n²).
  const candidatesBySession = new Map<string, CoverCandidate[]>();
  for (const row of coverRows) {
    const existing = candidatesBySession.get(row.orderSessionId);
    if (existing) {
      existing.push(row);
    } else {
      candidatesBySession.set(row.orderSessionId, [row]);
    }
  }

  const rows = orders.map((o) => ({
    id: o.id,
    createdAt: o.createdAt,
    customerName: o.shippingName,
    customerEmail: o.notificationEmail,
    customerPhone: o.shippingPhone,
    amount: o.amount.toString(),
    currency: o.currency,
    status: o.status,
    trackingStatus: o.trackingStatus,
    awbNumber: o.awbNumber,
    courierName: o.courierName,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    childName: o.orderSession.childName,
    comicTitle: o.orderSession.comic.title,
    // Null when nothing is generated yet — the client renders a placeholder.
    coverImageUrl:
      pickGeneratedCover(candidatesBySession.get(o.orderSession.id) ?? [])
        ?.imageUrl ?? null,
  }));

  return {
    orders: rows,
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}

// ============================================================
// ADMIN ORDER DETAIL (Section 7 — endpoint 2 of 8)
// ============================================================
//
// Full-detail view for a single order. Everything the admin needs on
// one screen — customer + payment + shipping + shipment + webhook
// history — no separate calls required.
//
// Two decisions locked earlier this session:
//   1. Include attached User's name + email (from OrderSession.user).
//      Admin needs to distinguish "who paid" from "who receives" —
//      the shipping snapshot can differ (gift shipping).
//   2. WebhookEvent.payloadJson returned as-is, not trimmed. Admin
//      panel renders it collapsed; audit trail per Aug 29 decision.
//
// Returns raw trackingStatus alongside mapped publicStatus per the
// Aug 29 status-visibility split (admin sees both, user sees mapped).

export async function getAdminOrderDetail(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      orderSession: {
        select: {
          id: true,
          childName: true,
          pronounKey: true,
          age: true,
          user: {
            select: { id: true, name: true, email: true },
          },
          comic: {
            select: { id: true, title: true, coverThumbnailUrls: true },
          },
          // Every finished page-1 variant for this session. Bounded by the
          // per-page variant cap (8 after payment), so this is a handful of
          // rows — pickGeneratedCover decides which one is the cover.
          pageVersions: {
            where: {
              page: { pageNumber: COVER_PAGE_NUMBER },
              status: "SD_READY",
            },
            select: {
              variantIndex: true,
              isSelected: true,
              displayImageUrl: true,
              finalImageUrl: true,
            },
          },
        },
      },
      webhookEvents: {
        orderBy: { processedAt: "desc" },
        select: {
          id: true,
          source: true,
          eventId: true,
          eventType: true,
          processedAt: true,
          payloadJson: true,
        },
      },
    },
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,

    amount: order.amount.toString(),
    currency: order.currency,
    countryCode: order.countryCode,
    coverType: order.coverType,

    status: order.status,
    publicStatus: toPublicStatus(order.status),

    customer: {
      notificationEmail: order.notificationEmail,
      user: order.orderSession.user, // null if anonymous session never attached a login
    },

    shipping: {
      name: order.shippingName,
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      city: order.shippingCity,
      state: order.shippingState,
      zip: order.shippingZip,
      country: order.shippingCountry,
      phone: order.shippingPhone,
    },

    payment: {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
    },

    pdf: {
      pdfUrl: order.pdfUrl,
      pdfDownloadUrl: order.pdfDownloadUrl,
      pdfDownloadExpiry: order.pdfDownloadExpiry,
    },

    shipment: {
      shiprocketOrderId: order.shiprocketOrderId,
      shiprocketShipmentId: order.shiprocketShipmentId,
      awbNumber: order.awbNumber,
      courierId: order.courierId,
      courierName: order.courierName,
      trackingStatus: order.trackingStatus, // raw — admin only
      trackingUrl: order.trackingUrl,
      trackingUpdatedAt: order.trackingUpdatedAt,
      isInternational: order.isInternational,
    },

    dimensions: {
      finalLength: order.finalLength,
      finalBreadth: order.finalBreadth,
      finalHeight: order.finalHeight,
      finalWeight: order.finalWeight,
    },

    timestamps: {
      awbGeneratedAt: order.awbGeneratedAt,
      labelGeneratedAt: order.labelGeneratedAt,
      pickupScheduledDate: order.pickupScheduledDate,
      pickupGeneratedAt: order.pickupGeneratedAt,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
    },

    session: {
      id: order.orderSession.id,
      childName: order.orderSession.childName,
      pronounKey: order.orderSession.pronounKey,
      age: order.orderSession.age,
      comic: order.orderSession.comic,
    },

    // The personalised page this child's book opens on. Null until page 1 has
    // generated. `isSelected` tells the admin whether they are looking at the
    // cover that was actually printed or the customer's current best guess.
    generatedCover: pickGeneratedCover(order.orderSession.pageVersions),

    webhookEvents: order.webhookEvents,
  };
}
