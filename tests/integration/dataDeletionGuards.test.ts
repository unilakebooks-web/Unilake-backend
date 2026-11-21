// Integration tests for what automatic data deletion changes in the customer and admin paths (feature 6): the payment
// webhook when the files are already gone, the checkout and coupon refusals, the session and order flags, the page
// regeneration refusals and the generation worker's guard. Neon TEST branch and local MinIO only; Redis and Razorpay
// are replaced by stubs.
import "../setup/env.js";
import { createHmac } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { addBulk, rzpCreate, notify } = vi.hoisted(() => ({
  addBulk: vi.fn(async () => []),
  rzpCreate: vi.fn(),
  notify: {
    received: vi.fn(async () => ({ sent: true })),
    afterDeletion: vi.fn(async () => ({ sent: true })),
  },
}));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk, getJob: vi.fn(async () => null) },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/razorpay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/razorpay.js")>()),
  razorpay: { orders: { create: rzpCreate } },
}));
vi.mock(
  "../../src/services/notification.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/services/notification.service.js")
    >()),
    notifyPaymentReceived: notify.received,
    notifyPaidAfterDeletion: notify.afterDeletion,
  })
);

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import { handleRazorpayWebhook } from "../../src/services/webhook.service.js";
import { initiateCheckout } from "../../src/services/checkout.service.js";
import {
  listCouponOffers,
  previewCoupon,
} from "../../src/services/couponCheckout.service.js";
import {
  getOrderSessionId,
  regeneratePage,
} from "../../src/services/session.service.js";
import {
  getAdminOrderDetail,
  getUserOrder,
  listAdminOrders,
  listUserOrders,
} from "../../src/services/order.service.js";
import { failPageVersionIfFilesDeleted } from "../../src/services/pageVersionDeletionGuard.js";
import { orderRule } from "../../src/utils/pageRecovery.js";

const MARK = "__vitest_deletion_guards__";
const RUN = Math.random().toString(36).slice(2, 8);
const NOW = Date.now();
const H = 3600_000;

let comicId: string;
let pageId: string;
let userId: string;
const sessionIds: string[] = [];

async function mk(opts: {
  status?: "PREVIEW_READY" | "AWAITING_PAYMENT" | "PAID" | "COMPLETED";
  marker?: "files" | "photo" | null;
  order?: {
    status: "CREATED" | "PAID" | "DELIVERED";
    pdfUrl?: string | null;
    pdfDeleted?: boolean;
  };
}) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      userId,
      status: opts.status ?? "PREVIEW_READY",
      expiresAt: new Date(NOW + 24 * H),
      rawPhotoUrls: [],
      coverType: "HARDCOVER",
      shippingCountry: "IN",
      childName: "Aarav",
    },
  });
  sessionIds.push(session.id);
  if (opts.marker) {
    const t = new Date();
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${t}, "filesDeletedAt" = ${opts.marker === "files" ? t : null} WHERE "id" = ${session.id}`;
  }
  let orderId: string | null = null;
  let razorpayOrderId: string | null = null;
  if (opts.order) {
    razorpayOrderId = `order_${RUN}_${session.id.slice(0, 8)}`;
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: opts.order.status,
        razorpayOrderId,
        pdfUrl: opts.order.pdfUrl ?? null,
        pdfDownloadUrl: opts.order.pdfUrl
          ? "https://example.test/signed.pdf"
          : null,
        deliveredAt:
          opts.order.status === "DELIVERED"
            ? new Date(NOW - 60 * 24 * H)
            : null,
        shippingName: `${MARK} ${RUN}`,
        notificationEmail: `guards-${RUN}@example.test`,
      },
    });
    orderId = order.id;
    if (opts.order.pdfDeleted) {
      await prisma.$executeRaw`UPDATE "orders" SET "pdfDeletedAt" = ${new Date()} WHERE "id" = ${order.id}`;
    }
  }
  return { id: session.id, orderId, razorpayOrderId };
}

function signedCapture(
  razorpayOrderId: string,
  eventId: string,
  paymentId: string
) {
  const body = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          amount: 49900,
          currency: "INR",
          status: "captured",
        },
      },
    },
  });
  const signature = createHmac("sha256", config.razorpay.razorpayWebhookSecret)
    .update(body)
    .digest("hex");
  return { body: Buffer.from(body), signature, eventId };
}

async function cleanup() {
  const ids = [...new Set(sessionIds)];
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  ids.push(...sessions.map((s) => s.id));
  const orders = await prisma.order.findMany({
    where: { orderSessionId: { in: ids } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.webhookEvent.deleteMany({
    where: {
      OR: [
        { orderId: { in: orderIds } },
        { eventId: { startsWith: `evt_${MARK}` } },
      ],
    },
  });
  await prisma.couponRedemption.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
  sessionIds.length = 0;
}

beforeAll(async () => {
  await cleanup();
  userId = `${MARK}-${RUN}-user`;
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN}`,
      pageCount: 2,
      freePreviewPages: 1,
      status: "PUBLISHED",
    },
  });
  comicId = comic.id;
  pageId = (
    await prisma.page.create({
      data: {
        comicId,
        pageNumber: 1,
        hasFace: true,
        artworkUrl: "https://example.test/a.png",
        isPreviewPage: true,
      },
    })
  ).id;
});

beforeEach(() => {
  addBulk.mockClear();
  rzpCreate.mockReset();
  notify.received.mockClear();
  notify.afterDeletion.mockClear();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("the payment webhook when the files are already deleted", () => {
  it("records the payment, makes no book, sends the plain mail once, and flags the order", async () => {
    const s = await mk({
      status: "AWAITING_PAYMENT",
      marker: "files",
      order: { status: "CREATED" },
    });
    const first = signedCapture(
      s.razorpayOrderId!,
      `evt_${MARK}_${RUN}_1`,
      `pay_${RUN}_1`
    );
    await handleRazorpayWebhook(first.body, first.signature, first.eventId);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: s.orderId! },
    });
    expect(order.status).toBe("PAID");
    expect(order.razorpayPaymentId).toBe(`pay_${RUN}_1`);
    expect(order.paidAfterDeletionAt).not.toBeNull();
    // the session stays PAID: it was never moved to GENERATING_PAID, and nothing was queued
    expect(
      (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("PAID");
    expect(addBulk).not.toHaveBeenCalled();
    expect(notify.received).not.toHaveBeenCalled();
    expect(notify.afterDeletion).toHaveBeenCalledTimes(1);
    // a redelivery with a new event id: still no book, and no second mail
    const second = signedCapture(
      s.razorpayOrderId!,
      `evt_${MARK}_${RUN}_2`,
      `pay_${RUN}_1`
    );
    await handleRazorpayWebhook(second.body, second.signature, second.eventId);
    expect(notify.afterDeletion).toHaveBeenCalledTimes(1);
    expect(notify.received).not.toHaveBeenCalled();
    expect(
      (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("PAID");
  });

  it("a redelivery for an order that is already PAID never flags it or sends the mail (only the delivery that flipped it does)", async () => {
    const s = await mk({
      status: "PAID",
      marker: "files",
      order: { status: "PAID" },
    });
    const evt = signedCapture(
      s.razorpayOrderId!,
      `evt_${MARK}_${RUN}_redeliver`,
      `pay_${RUN}_redeliver`
    );
    await handleRazorpayWebhook(evt.body, evt.signature, evt.eventId);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: s.orderId! },
    });
    expect(order.paidAfterDeletionAt).toBeNull();
    expect(notify.afterDeletion).not.toHaveBeenCalled();
    expect(notify.received).not.toHaveBeenCalled();
    expect(addBulk).not.toHaveBeenCalled();
    expect(
      (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("PAID");
  });

  it("a deletion claim that commits between the webhook's read and its transaction is still seen: no book, flagged, one mail", async () => {
    const s = await mk({
      status: "AWAITING_PAYMENT",
      marker: null,
      order: { status: "CREATED" },
    });
    const client = prisma as unknown as {
      $transaction: (...args: unknown[]) => Promise<unknown>;
    };
    const real = client.$transaction.bind(prisma);
    client.$transaction = async (...args: unknown[]) => {
      // the claim commits here: after the webhook read the unmarked session, before its transaction starts
      client.$transaction = real;
      const t = new Date();
      await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${t}, "filesDeletedAt" = ${t} WHERE "id" = ${s.id}`;
      return real(...args);
    };
    try {
      const evt = signedCapture(
        s.razorpayOrderId!,
        `evt_${MARK}_${RUN}_interleave`,
        `pay_${RUN}_interleave`
      );
      await handleRazorpayWebhook(evt.body, evt.signature, evt.eventId);
    } finally {
      client.$transaction = real;
    }
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: s.orderId! },
    });
    expect(order.status).toBe("PAID");
    expect(order.paidAfterDeletionAt).not.toBeNull();
    expect(addBulk).not.toHaveBeenCalled();
    expect(notify.received).not.toHaveBeenCalled();
    expect(notify.afterDeletion).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("PAID");
  });

  it("a normal payment is unchanged: GENERATING_PAID, the 'payment received' mail, no flag", async () => {
    const s = await mk({
      status: "AWAITING_PAYMENT",
      marker: null,
      order: { status: "CREATED" },
    });
    const evt = signedCapture(
      s.razorpayOrderId!,
      `evt_${MARK}_${RUN}_3`,
      `pay_${RUN}_3`
    );
    await handleRazorpayWebhook(evt.body, evt.signature, evt.eventId);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: s.orderId! },
    });
    expect(order.status).toBe("PAID");
    expect(order.paidAfterDeletionAt).toBeNull();
    expect(
      (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.id } }))
        .status
    ).toBe("GENERATING_PAID");
    expect(notify.received).toHaveBeenCalledTimes(1);
    expect(notify.afterDeletion).not.toHaveBeenCalled();
  });
});

describe("checkout and coupons refuse a deleted preview", () => {
  it("initiateCheckout refuses an unpaid session whose files were deleted, before any Razorpay call", async () => {
    const s = await mk({ status: "PREVIEW_READY", marker: "files" });
    await expect(initiateCheckout(s.id, {})).rejects.toMatchObject({
      code: "PREVIEW_DELETED",
    });
    expect(rzpCreate).not.toHaveBeenCalled();
  });

  it("a paid order keeps its own message and is not called 'expired'", async () => {
    const s = await mk({
      status: "PAID",
      marker: "photo",
      order: { status: "PAID" },
    });
    await expect(initiateCheckout(s.id, {})).rejects.not.toMatchObject({
      code: "PREVIEW_DELETED",
    });
  });

  it("coupon offers are empty and a preview is refused for a deleted preview", async () => {
    const s = await mk({ status: "PREVIEW_READY", marker: "files" });
    expect(await listCouponOffers(s.id, userId)).toEqual({ offers: [] });
    await expect(previewCoupon(s.id, userId, "ANYCODE")).rejects.toMatchObject({
      code: "PREVIEW_DELETED",
    });
  });
});

describe("what the customer and the admin are shown", () => {
  it("the session snapshot flags a deleted unpaid preview as expired, and a paid one with its flags", async () => {
    const unpaid = await mk({ status: "PREVIEW_READY", marker: "files" });
    const snap = await getOrderSessionId(unpaid.id);
    expect(snap.isExpired).toBe(true);
    expect(snap.filesDeleted).toBe(true);
    expect(snap.photoDeleted).toBe(true);
    const paid = await mk({
      status: "PAID",
      marker: "files",
      order: { status: "PAID" },
    });
    await prisma.$executeRaw`UPDATE "orders" SET "paidAfterDeletionAt" = ${new Date()} WHERE "id" = ${paid.orderId}`;
    const paidSnap = await getOrderSessionId(paid.id);
    expect(paidSnap.isExpired).toBe(false);
    expect(paidSnap.paidAfterDeletion).toBe(true);
    const normal = await mk({ status: "PREVIEW_READY", marker: null });
    const normalSnap = await getOrderSessionId(normal.id);
    expect(normalSnap.isExpired).toBe(false);
    expect([
      normalSnap.photoDeleted,
      normalSnap.filesDeleted,
      normalSnap.pdfDeleted,
      normalSnap.paidAfterDeletion,
    ]).toEqual([false, false, false, false]);
  });

  it("customer and admin order views carry the flags, hide the PDF link and show no generated cover", async () => {
    const s = await mk({
      status: "COMPLETED",
      marker: "files",
      order: {
        status: "DELIVERED",
        pdfUrl: `pdfs/${RUN}.pdf`,
        pdfDeleted: true,
      },
    });
    await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId,
        status: "SD_READY",
        finalImageUrl: "https://example.test/final.png",
        displayImageUrl: "https://example.test/display.png",
      },
    });
    const detail = await getUserOrder(s.orderId!, userId);
    expect(detail).toMatchObject({
      photoDeleted: true,
      filesDeleted: true,
      pdfDeleted: true,
      pdfDownloadUrl: null,
      generatedCover: null,
    });
    const list = (await listUserOrders(userId)).find((o) => o.id === s.orderId);
    expect(list).toMatchObject({
      filesDeleted: true,
      pdfDeleted: true,
      generatedCover: null,
    });
    const admin = await getAdminOrderDetail(s.orderId!);
    expect(admin.deletion).toEqual({
      photoDeleted: true,
      filesDeleted: true,
      pdfDeleted: true,
      paidAfterDeletion: false,
    });
    expect(admin.pdf.pdfDownloadUrl).toBeNull();
    expect(admin.generatedCover).toBeNull();
    const adminList = await listAdminOrders({
      page: 1,
      pageSize: 50,
      sortBy: "createdAt",
      sortOrder: "desc",
      search: `${MARK} ${RUN}`,
    } as never);
    const row = adminList.orders.find((o) => o.id === s.orderId);
    expect(row).toMatchObject({
      filesDeleted: true,
      pdfDeleted: true,
      coverImageUrl: null,
    });
  });

  it("an order that is not deleted looks exactly as before (flags false, link kept)", async () => {
    const s = await mk({
      status: "COMPLETED",
      marker: null,
      order: { status: "DELIVERED", pdfUrl: `pdfs/${RUN}-b.pdf` },
    });
    const detail = await getUserOrder(s.orderId!, userId);
    expect(detail).toMatchObject({
      photoDeleted: false,
      filesDeleted: false,
      pdfDeleted: false,
      pdfDownloadUrl: "https://example.test/signed.pdf",
    });
  });
});

describe("regeneration and the worker", () => {
  it("regeneratePage refuses a session whose files were deleted, paid or not", async () => {
    const unpaid = await mk({ status: "PREVIEW_READY", marker: "files" });
    await expect(regeneratePage(unpaid.id, 1)).rejects.toThrow(
      /deleted for your privacy/
    );
    const paid = await mk({
      status: "PAID",
      marker: "photo",
      order: { status: "PAID" },
    });
    await expect(regeneratePage(paid.id, 1)).rejects.toThrow(
      /deleted for your privacy/
    );
  });

  it("orderRule refuses a session with deleted files with a reason", () => {
    const order = {
      status: "PAID" as const,
      pdfUrl: null,
      updatedAt: new Date(NOW - 60 * 60 * H),
    };
    expect(orderRule(order, "PAID", new Date(NOW), false).canRegenerate).toBe(
      true
    );
    const rule = orderRule(order, "PAID", new Date(NOW), true);
    expect(rule.canRegenerate).toBe(false);
    expect(rule.blockedReason).toMatch(/deleted/);
  });

  it("the generation worker's guard fails a live page version of a marked session and lets an unmarked one run", async () => {
    const marked = await mk({ status: "PREVIEW_READY", marker: "files" });
    const live = await prisma.pageVersion.create({
      data: { orderSessionId: marked.id, pageId, status: "QUEUED" },
    });
    const session = await prisma.orderSession.findUniqueOrThrow({
      where: { id: marked.id },
    });
    expect(await failPageVersionIfFilesDeleted(live.id, session)).toBe(true);
    expect(
      (await prisma.pageVersion.findUniqueOrThrow({ where: { id: live.id } }))
        .status
    ).toBe("FAILED");
    const fine = await mk({ status: "PREVIEW_READY", marker: null });
    const fineVersion = await prisma.pageVersion.create({
      data: { orderSessionId: fine.id, pageId, status: "QUEUED" },
    });
    const fineSession = await prisma.orderSession.findUniqueOrThrow({
      where: { id: fine.id },
    });
    expect(
      await failPageVersionIfFilesDeleted(fineVersion.id, fineSession)
    ).toBe(false);
    expect(
      (
        await prisma.pageVersion.findUniqueOrThrow({
          where: { id: fineVersion.id },
        })
      ).status
    ).toBe("QUEUED");
  });
});
