// Integration tests for automatic data deletion (feature 6): selection boundaries, the money guard, the claim,
// delete and verify path, ghosts, storage faults and the mode gates. They run against the Neon TEST branch and
// the local MinIO buckets only (the setup import refuses anything else). Every selection is scoped to this
// file's own comic (deps.onlyComicId) because the test database is shared; the clock is injected.
import "../setup/env.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import {
  countPrefix,
  deletePrefix,
  r2Client,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  sweepDataDeletion,
  setGroupMode,
} from "../../src/services/dataDeletion.service.js";
import type { DeletionDeps } from "../../src/services/dataDeletionEngine.service.js";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";

const MARK = "__vitest_deletion__";
const RUN = Math.random().toString(36).slice(2, 8);
const NOW = new Date("2031-06-15T12:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const rzp = {
  fetchPayments: vi.fn(
    async (_id: string): Promise<unknown> => ({
      entity: "collection",
      count: 0,
      items: [],
    })
  ),
  fetchOrder: vi.fn(
    async (_id: string): Promise<unknown> => ({ status: "created" })
  ),
};
let comicId: string;
let pageId: string;
const deps = (): DeletionDeps => ({
  now: () => NOW,
  rzp,
  onlyComicId: comicId,
});
const sessionIds: string[] = [];

interface OrderOpts {
  status?: "CREATED" | "PAID" | "GENERATED" | "DELIVERED" | "CANCELLED";
  updatedAt?: Date;
  deliveredAt?: Date | null;
  createdAt?: Date;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  billNumber?: string;
  superseded?: string[];
}

interface SessionOpts {
  status?:
    | "CREATED"
    | "PHOTO_UPLOADED"
    | "PREVIEW_READY"
    | "AWAITING_PAYMENT"
    | "PAID"
    | "FAILED";
  expiresAt: Date;
  createdAt?: Date;
  isSample?: boolean;
  photo?: boolean;
  /** Pages with real files, as SD_READY versions of a page that uses the face. */
  pages?: number;
  ghostPhoto?: boolean;
  liveVersion?: boolean;
  order?: OrderOpts;
}

async function mkSession(o: SessionOpts) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: o.status ?? "PREVIEW_READY",
      expiresAt: o.expiresAt,
      isSample: o.isSample ?? false,
      rawPhotoUrls: [],
    },
  });
  sessionIds.push(session.id);
  if (o.createdAt) {
    await prisma.$executeRaw`UPDATE "order_sessions" SET "createdAt" = ${o.createdAt} WHERE "id" = ${session.id}`;
  }
  if (o.photo || o.ghostPhoto) {
    const key = `sessions/${session.id}/photo-1.jpg`;
    if (o.photo)
      await uploadFile("private", key, Buffer.from("photo"), "image/jpeg");
    await prisma.orderSession.update({
      where: { id: session.id },
      data: { bestPhotoUrl: key, rawPhotoUrls: [key] },
    });
  }
  for (let n = 0; n < (o.pages ?? 0); n++) {
    const key = `sessions/${session.id}/final-${n}.png`;
    await uploadFile("public", key, Buffer.from("page"), "image/png");
    await prisma.pageVersion.create({
      data: {
        orderSessionId: session.id,
        pageId,
        variantIndex: n,
        status: "SD_READY",
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
      },
    });
  }
  if (o.liveVersion) {
    await prisma.pageVersion.create({
      data: {
        orderSessionId: session.id,
        pageId,
        variantIndex: 9,
        status: "GENERATING_SD",
      },
    });
  }
  let orderId: string | null = null;
  if (o.order) {
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: o.order.status ?? "CREATED",
        razorpayOrderId:
          o.order.razorpayOrderId ?? `order_${RUN}_${session.id.slice(0, 8)}`,
        razorpayPaymentId: o.order.razorpayPaymentId,
        billNumber: o.order.billNumber,
        deliveredAt: o.order.deliveredAt ?? null,
        shippingName: `${MARK} ${RUN}`,
        supersededRazorpayOrderIds: o.order.superseded ?? [],
      },
    });
    orderId = order.id;
    if (o.order.updatedAt || o.order.createdAt) {
      await prisma.$executeRaw`UPDATE "orders" SET "updatedAt" = ${o.order.updatedAt ?? NOW}, "createdAt" = ${o.order.createdAt ?? ago(400 * DAY)} WHERE "id" = ${order.id}`;
    }
  }
  return { id: session.id, orderId };
}

const state = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true, updatedAt: true },
  });

async function setMode(
  group: "PREVIEWS" | "PHOTOS" | "BOOKS",
  mode: "OFF" | "REPORT_ONLY" | "ACTIVE"
) {
  await prisma.deletionGroupSetting.update({
    where: { group },
    data: {
      mode,
      modeChangedAt: ago(10 * DAY),
      approvedSelectionVersion: SELECTION_VERSION[group],
      approvedRunId: null,
      approvedAt: mode === "ACTIVE" ? ago(DAY) : null,
      approvalExhaustedAt: mode === "ACTIVE" ? ago(DAY) : null,
      pausedReason: null,
      pausedAt: null,
      dailyMax: 100,
      lastReportAt: null,
    },
  });
}

async function cleanup() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  for (const { id } of sessions) sessionIds.push(id);
  for (const id of new Set(sessionIds)) {
    await deletePrefix("public", `sessions/${id}/`);
    await deletePrefix("private", `sessions/${id}/`);
  }
  const ids = [...new Set(sessionIds)];
  await prisma.webhookEvent.deleteMany({
    where: { eventId: { startsWith: `${MARK}-${RUN}` } },
  });
  await prisma.deletionItem.deleteMany({ where: { subjectId: { in: ids } } });
  await prisma.deletionBlock.deleteMany({});
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({
    where: { shippingName: { startsWith: MARK } },
  });
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN}`,
      pageCount: 2,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
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

async function wipeSessions() {
  const ids = [...new Set(sessionIds)];
  sessionIds.length = 0;
  await Promise.all(
    ids.flatMap((id) => [
      deletePrefix("public", `sessions/${id}/`),
      deletePrefix("private", `sessions/${id}/`),
    ])
  );
  await prisma.webhookEvent.deleteMany({
    where: { eventId: { startsWith: `${MARK}-${RUN}` } },
  });
  await prisma.deletionItem.deleteMany({ where: { subjectId: { in: ids } } });
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  await wipeSessions();
  // Runs sort by start time, and the clock is injected: leftovers of an earlier execution would win.
  await prisma.deletionRun.deleteMany({});
  rzp.fetchPayments.mockReset();
  rzp.fetchPayments.mockImplementation(async () => ({
    entity: "collection",
    count: 0,
    items: [],
  }));
  rzp.fetchOrder.mockReset();
  rzp.fetchOrder.mockImplementation(async () => ({ status: "created" }));
  await prisma.deletionBlock.deleteMany({});
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: NOW, leaseUntil: null, leaseOwner: null },
  });
  await setMode("PREVIEWS", "ACTIVE");
  await setMode("PHOTOS", "OFF");
  await setMode("BOOKS", "OFF");
});

afterAll(async () => {
  await cleanup();
  await prisma.deletionRun.deleteMany({});
  for (const g of ["PREVIEWS", "PHOTOS", "BOOKS"] as const) {
    await prisma.deletionGroupSetting.update({
      where: { group: g },
      data: {
        mode: "REPORT_ONLY",
        approvedRunId: null,
        approvedAt: null,
        approvalExhaustedAt: null,
        pausedReason: null,
        pausedAt: null,
      },
    });
  }
  await prisma.$disconnect();
});

describe("R1: unpaid previews", () => {
  it("waits for expiresAt + 1 hour, to the second, then deletes both folders and sets both markers", async () => {
    const early = await mkSession({
      expiresAt: ago(HOUR - 1000),
      photo: true,
      pages: 1,
    });
    const exact = await mkSession({
      expiresAt: ago(HOUR),
      photo: true,
      pages: 1,
    });
    const late = await mkSession({
      expiresAt: ago(HOUR + 1000),
      photo: true,
      pages: 1,
    });
    await sweepDataDeletion(deps());
    expect((await state(early.id)).filesDeletedAt).toBeNull();
    expect(await countPrefix("private", `sessions/${early.id}/`)).toBe(1);
    for (const s of [exact, late]) {
      const row = await state(s.id);
      expect(row.photoDeletedAt).not.toBeNull();
      expect(row.filesDeletedAt).not.toBeNull();
      expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
      expect(await countPrefix("public", `sessions/${s.id}/`)).toBe(0);
      const item = await prisma.deletionItem.findUniqueOrThrow({
        where: { subjectId_scope: { subjectId: s.id, scope: "SESSION" } },
      });
      expect(item.state).toBe("DONE");
    }
  });

  it("does not move updatedAt of the session when it writes the markers", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    const before = (await state(s.id)).updatedAt;
    await sweepDataDeletion(deps());
    const after = await state(s.id);
    expect(after.filesDeletedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.getTime());
  });

  it("walks the order states: only no order or a CREATED order that is old enough is deleted", async () => {
    const old = ago(3 * DAY);
    const cases: { name: string; opts: SessionOpts; deleted: boolean }[] = [
      {
        name: "no order",
        opts: { expiresAt: ago(2 * HOUR), photo: true },
        deleted: true,
      },
      {
        name: "CREATED, touched 3 days ago",
        opts: {
          status: "AWAITING_PAYMENT",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { updatedAt: old },
        },
        deleted: true,
      },
      {
        name: "CREATED, touched 1 hour ago",
        opts: {
          status: "AWAITING_PAYMENT",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { updatedAt: ago(HOUR) },
        },
        deleted: false,
      },
      {
        name: "PAID order",
        opts: {
          status: "PAID",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { status: "PAID", updatedAt: old },
        },
        deleted: false,
      },
      {
        name: "GENERATED order, FAILED session",
        opts: {
          status: "FAILED",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { status: "GENERATED", updatedAt: old },
        },
        deleted: false,
      },
      {
        name: "DELIVERED order",
        opts: {
          status: "PAID",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { status: "DELIVERED", updatedAt: old, deliveredAt: ago(DAY) },
        },
        deleted: false,
      },
      {
        name: "CANCELLED order",
        opts: {
          status: "PREVIEW_READY",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { status: "CANCELLED", updatedAt: old },
        },
        deleted: false,
      },
      {
        name: "sample",
        opts: { expiresAt: ago(2 * HOUR), photo: true, isSample: true },
        deleted: false,
      },
      {
        name: "page version still generating",
        opts: { expiresAt: ago(2 * HOUR), photo: true, liveVersion: true },
        deleted: false,
      },
      {
        name: "CREATED order with a payment id",
        opts: {
          status: "AWAITING_PAYMENT",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { updatedAt: old, razorpayPaymentId: `pay_${RUN}_a` },
        },
        deleted: false,
      },
      {
        name: "CREATED order with a bill number",
        opts: {
          status: "AWAITING_PAYMENT",
          expiresAt: ago(2 * HOUR),
          photo: true,
          order: { updatedAt: old, billNumber: `BOS-${RUN}-1` },
        },
        deleted: false,
      },
    ];
    const made = [];
    for (const c of cases) made.push({ ...c, s: await mkSession(c.opts) });
    await sweepDataDeletion(deps());
    for (const c of made) {
      const row = await state(c.s.id);
      expect(row.filesDeletedAt !== null, c.name).toBe(c.deleted);
      expect(
        (await countPrefix("private", `sessions/${c.s.id}/`)) === 0,
        c.name
      ).toBe(c.deleted);
    }
  });

  it("holds a CREATED order past the 2-day clock, but not past the 3-day cap", async () => {
    const recent = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * DAY),
      photo: true,
      order: { updatedAt: ago(HOUR) },
    });
    const afterCap = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(3 * DAY + HOUR),
      photo: true,
      order: { updatedAt: ago(HOUR) },
    });
    await sweepDataDeletion(deps());
    expect((await state(recent.id)).filesDeletedAt).toBeNull();
    expect((await state(afterCap.id)).filesDeletedAt).not.toBeNull();
  });
});

describe("the money guard", () => {
  const settled = (extra: Partial<OrderOpts> = {}) => ({
    updatedAt: ago(3 * DAY),
    ...extra,
  });

  it("a stored payment.authorized event that names the Razorpay order blocks, even though it is not linked", async () => {
    const rid = `order_${RUN}_authorized`;
    const s = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * HOUR),
      photo: true,
      order: settled({ razorpayOrderId: rid }),
    });
    await prisma.webhookEvent.create({
      data: {
        source: "razorpay",
        eventId: `${MARK}-${RUN}-auth`,
        eventType: "payment.authorized",
        payloadJson: {
          payload: { payment: { entity: { order_id: rid, id: "pay_x" } } },
        },
      },
    });
    await sweepDataDeletion(deps());
    expect((await state(s.id)).filesDeletedAt).toBeNull();
  });

  it("an order.paid event with the id at the other payload path blocks too", async () => {
    const rid = `order_${RUN}_paidpath`;
    const s = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * HOUR),
      photo: true,
      order: settled({ razorpayOrderId: rid }),
    });
    await prisma.webhookEvent.create({
      data: {
        source: "razorpay",
        eventId: `${MARK}-${RUN}-paid`,
        eventType: "order.paid",
        payloadJson: { payload: { order: { entity: { id: rid } } } },
      },
    });
    await sweepDataDeletion(deps());
    expect((await state(s.id)).filesDeletedAt).toBeNull();
  });

  it("a payment.failed event never blocks", async () => {
    const rid = `order_${RUN}_failedonly`;
    const s = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * HOUR),
      photo: true,
      order: settled({ razorpayOrderId: rid }),
    });
    await prisma.webhookEvent.create({
      data: {
        source: "razorpay",
        eventId: `${MARK}-${RUN}-failed`,
        eventType: "payment.failed",
        payloadJson: { payload: { payment: { entity: { order_id: rid } } } },
      },
    });
    await sweepDataDeletion(deps());
    expect((await state(s.id)).filesDeletedAt).not.toBeNull();
  });

  const razorpayCases: {
    name: string;
    answer: () => Promise<unknown>;
    deleted: boolean;
  }[] = [
    {
      name: "no payments",
      answer: async () => ({ entity: "collection", count: 0, items: [] }),
      deleted: true,
    },
    {
      name: "a captured payment",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "captured",
            created_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "an authorized payment",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "authorized",
            created_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "a refunded payment",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "refunded",
            created_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "a payment with an unknown status",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "weird",
            created_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "a failed payment 1 hour ago",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "failed",
            created_at: Math.floor(NOW.getTime() / 1000) - 3600,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "a failed payment 3 days ago",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "failed",
            created_at: Math.floor(NOW.getTime() / 1000) - 3 * 86400,
          },
        ],
      }),
      deleted: true,
    },
    {
      name: "a payment still created 10 minutes ago",
      answer: async () => ({
        entity: "collection",
        count: 1,
        items: [
          {
            status: "created",
            created_at: Math.floor(NOW.getTime() / 1000) - 600,
          },
        ],
      }),
      deleted: false,
    },
    {
      name: "an error",
      answer: async () => {
        throw new Error("boom");
      },
      deleted: false,
    },
    {
      name: "a malformed answer (count differs)",
      answer: async () => ({ entity: "collection", count: 2, items: [] }),
      deleted: false,
    },
    {
      name: "an answer that is not a collection",
      answer: async () => ({ hello: "world" }),
      deleted: false,
    },
  ];
  for (const c of razorpayCases) {
    it(`Razorpay says: ${c.name}`, async () => {
      const s = await mkSession({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        photo: true,
        order: settled(),
      });
      rzp.fetchPayments.mockImplementation(c.answer as () => Promise<unknown>);
      await sweepDataDeletion(deps());
      expect((await state(s.id)).filesDeletedAt !== null).toBe(c.deleted);
    });
  }

  it("checks every superseded Razorpay order too", async () => {
    const s = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * HOUR),
      photo: true,
      order: settled({
        superseded: [`order_${RUN}_old1`, `order_${RUN}_old2`],
      }),
    });
    rzp.fetchPayments.mockImplementation(async (id: string) =>
      id.endsWith("old2")
        ? {
            entity: "collection",
            count: 1,
            items: [
              {
                status: "captured",
                created_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400,
              },
            ],
          }
        : { entity: "collection", count: 0, items: [] }
    );
    await sweepDataDeletion(deps());
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    expect(rzp.fetchPayments).toHaveBeenCalledTimes(3);
  });
});

describe("storage faults and ghosts", () => {
  it("a delete that Razorpay-style acknowledges but does not happen is never DONE", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const original = r2Client.send.bind(r2Client);
    (r2Client as { send: unknown }).send = async (
      cmd: unknown,
      opts: unknown
    ) => {
      if (cmd instanceof DeleteObjectCommand) return {};
      return (original as (c: unknown, o: unknown) => Promise<unknown>)(
        cmd,
        opts
      );
    };
    try {
      await expect(sweepDataDeletion(deps())).rejects.toThrow(
        /failed: verify_failed/
      );
    } finally {
      (r2Client as { send: unknown }).send = original;
    }
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: s.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("FAILED");
    expect(item.lastError).toMatch(/verify_failed/);
  });

  it("a recorded photo with no object is a ghost: DONE, flagged, once the bucket proof passes", async () => {
    // The proof needs a real, evidenced, undeleted session whose photo exists and is older than 6 hours.
    const real = await mkSession({
      expiresAt: ago(10 * DAY),
      createdAt: ago(8 * HOUR),
      photo: true,
      pages: 1,
      status: "PAID",
      order: { status: "GENERATED", updatedAt: ago(DAY) },
    });
    const ghost = await mkSession({
      expiresAt: ago(2 * HOUR),
      ghostPhoto: true,
    });
    await sweepDataDeletion(deps());
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: ghost.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("DONE");
    expect(item.ghost).toBe(true);
    expect((await state(ghost.id)).filesDeletedAt).not.toBeNull();
    expect((await state(real.id)).filesDeletedAt).toBeNull();
  });

  it("with no evidenced session to prove the bucket with, a ghost is FAILED, not DONE", async () => {
    const ghost = await mkSession({
      expiresAt: ago(2 * HOUR),
      ghostPhoto: true,
    });
    await expect(sweepDataDeletion(deps())).rejects.toThrow(/ghost_unproven/);
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: ghost.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("FAILED");
  });

  it("a session with nothing recorded and nothing stored is simply DONE", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR) });
    await sweepDataDeletion(deps());
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: s.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("DONE");
    expect(item.ghost).toBe(false);
  });
});

// Runs and reports sort by their start time: in these tests the clock moves a millisecond per call, so two runs never tie.
let tick = 0;
const tdeps = (): DeletionDeps => ({
  ...deps(),
  now: () => new Date(NOW.getTime() + ++tick),
});

describe("modes", () => {
  it("OFF and REPORT_ONLY delete nothing; REPORT_ONLY writes a report", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await setMode("PREVIEWS", "OFF");
    await sweepDataDeletion(tdeps());
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    await setMode("PREVIEWS", "REPORT_ONLY");
    await sweepDataDeletion(tdeps());
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(1);
    const report = await prisma.deletionRun.findFirst({
      where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    expect(report?.dueCount).toBeGreaterThanOrEqual(1);
    expect((report?.lists as { due: string[] }).due).toContain(
      `SESSION:${s.id}`
    );
  });

  it("the first run after OFF to ACTIVE deletes only the approved report's items", async () => {
    const approved = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await setMode("PREVIEWS", "REPORT_ONLY");
    await sweepDataDeletion(tdeps());
    const report = await prisma.deletionRun.findFirstOrThrow({
      where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    const later = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await prisma.deletionGroupSetting.update({
      where: { group: "PREVIEWS" },
      data: {
        mode: "ACTIVE",
        approvedRunId: report.id,
        approvedSelectionVersion: SELECTION_VERSION.PREVIEWS,
        approvedAt: NOW,
        approvalExhaustedAt: null,
        modeChangedAt: ago(DAY),
      },
    });
    await sweepDataDeletion(tdeps());
    expect((await state(approved.id)).filesDeletedAt).not.toBeNull();
    expect((await state(later.id)).filesDeletedAt).toBeNull();
    // The approved set is used up, so the next run takes the later one.
    await sweepDataDeletion(tdeps());
    expect((await state(later.id)).filesDeletedAt).not.toBeNull();
  });

  it("a stale canary pauses the group with a reason and deletes nothing", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { canaryPassedAt: ago(3 * DAY) },
    });
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
      /PREVIEWS paused: canary_stale/
    );
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    // Paused for the second time: still no deletion, and no new throw.
    await expect(sweepDataDeletion(tdeps())).resolves.toBeTypeOf("number");
    const g = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    expect(g.pausedReason).toBe("canary_stale");
  });

  it("a selection version that differs from the approved one drops the group to REPORT_ONLY", async () => {
    await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await prisma.deletionGroupSetting.update({
      where: { group: "PREVIEWS" },
      data: { approvedSelectionVersion: 999 },
    });
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
      /selection_version_changed/
    );
    const g = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    expect(g.mode).toBe("REPORT_ONLY");
  });

  it("refuses ACTIVE without a report, with a stale confirmation, or with nothing due", async () => {
    await setMode("PREVIEWS", "REPORT_ONLY");
    await expect(
      setGroupMode("PREVIEWS", { mode: "ACTIVE" }, "a@b.test", tdeps())
    ).rejects.toThrow(/Read the latest report/);
    await sweepDataDeletion(tdeps());
    const report = await prisma.deletionRun.findFirstOrThrow({
      where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    await expect(
      setGroupMode(
        "PREVIEWS",
        {
          mode: "ACTIVE",
          reportRunId: report.id,
          dueCount: report.dueCount,
          confirmation: `DELETE ${report.dueCount}`,
        },
        "a@b.test",
        tdeps()
      )
    ).rejects.toThrow(/nothing to delete/);
  });
});

describe("safety rules added after review", () => {
  it("refuses to run, pauses the group and deletes nothing when the two bucket names are equal", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    const original = config.r2.privateBucket;
    (config.r2 as { privateBucket: string }).privateBucket =
      config.r2.publicBucket;
    try {
      await expect(sweepDataDeletion(deps())).rejects.toThrow(
        /PREVIEWS paused: buckets_equal/
      );
      const { runCanary } =
        await import("../../src/services/dataDeletionEngine.service.js");
      expect(await runCanary(deps(), true)).toEqual({
        ran: false,
        passed: false,
      });
    } finally {
      (config.r2 as { privateBucket: string }).privateBucket = original;
    }
    expect((await state(s.id)).filesDeletedAt).toBeNull();
  });

  it("a PAID order alone is not evidence that a photo exists: a ghost stays unproven (FAILED)", async () => {
    await mkSession({
      expiresAt: ago(10 * DAY),
      createdAt: ago(8 * HOUR),
      photo: true,
      status: "PAID",
      order: { status: "PAID", updatedAt: ago(DAY) },
    });
    const ghost = await mkSession({
      expiresAt: ago(2 * HOUR),
      ghostPhoto: true,
    });
    await expect(sweepDataDeletion(deps())).rejects.toThrow(/ghost_unproven/);
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: ghost.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("FAILED");
  });

  it("re-verify deletes late-written files only for a group that is ACTIVE", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await sweepDataDeletion(deps());
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
    // a late writer leaves a file after the item was DONE more than a day ago
    await uploadFile(
      "private",
      `sessions/${s.id}/photo-late.jpg`,
      Buffer.from("late"),
      "image/jpeg"
    );
    await prisma.$executeRaw`UPDATE "deletion_items" SET "doneAt" = ${ago(2 * DAY)}, "reverifiedAt" = NULL WHERE "subjectId" = ${s.id}`;
    await setMode("PREVIEWS", "REPORT_ONLY");
    await sweepDataDeletion(tdeps());
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(1);
    await setMode("PREVIEWS", "ACTIVE");
    await sweepDataDeletion(tdeps());
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: s.id, scope: "SESSION" } },
    });
    expect(item.reverifiedAt).not.toBeNull();
  });

  it("with every group OFF the sweep does nothing and does not even take the lease", async () => {
    await setMode("PREVIEWS", "OFF");
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { leaseUntil: null, leaseOwner: null },
    });
    const before = await prisma.deletionSetting.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(await sweepDataDeletion(tdeps())).toBe(0);
    const after = await prisma.deletionSetting.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("a proof pause lasts while the proof still fails: no new throw, and the pause time is kept", async () => {
    // a recent, undeleted, evidenced session whose public page file does not exist: the proof fails
    const bad = await mkSession({
      expiresAt: ago(10 * DAY),
      createdAt: ago(8 * HOUR),
      photo: true,
      status: "PAID",
      order: { status: "GENERATED", updatedAt: ago(DAY) },
    });
    await prisma.pageVersion.create({
      data: {
        orderSessionId: bad.id,
        pageId,
        status: "SD_READY",
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/sessions/${bad.id}/missing.png`,
      },
    });
    const pausedAt = new Date(NOW.getTime() - 3 * HOUR);
    await prisma.deletionGroupSetting.update({
      where: { group: "PREVIEWS" },
      data: { pausedReason: "proof_failed:public_pages", pausedAt },
    });
    await expect(sweepDataDeletion(tdeps())).resolves.toBeTypeOf("number");
    const g = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    expect(g.pausedReason).toBe("proof_failed:public_pages");
    expect(g.pausedAt?.getTime()).toBe(pausedAt.getTime());
  });
});
