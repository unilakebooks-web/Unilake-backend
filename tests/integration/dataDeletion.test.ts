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
  getDeletionOverview,
  purgeOldRows,
  setGroupMode,
  sweepDataDeletion,
  undoGhosts,
} from "../../src/services/dataDeletion.service.js";
import {
  ghostRateExceeded,
  type DeletionDeps,
} from "../../src/services/dataDeletionEngine.service.js";
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

/** Runs `body` with the storage client's send replaced (restored afterwards). */
async function withStorage(
  wrap: (
    cmd: unknown,
    original: (c: unknown, o: unknown) => Promise<unknown>,
    opts: unknown
  ) => Promise<unknown>,
  body: () => Promise<void>
) {
  const original = r2Client.send.bind(r2Client) as (
    c: unknown,
    o: unknown
  ) => Promise<unknown>;
  (r2Client as { send: unknown }).send = async (cmd: unknown, opts: unknown) =>
    wrap(cmd, original, opts);
  try {
    await body();
  } finally {
    (r2Client as { send: unknown }).send = original;
  }
}

describe("setbacks and the admin switch (after the pull request review)", () => {
  async function reportFor() {
    await setMode("PREVIEWS", "REPORT_ONLY");
    await sweepDataDeletion(tdeps());
    return prisma.deletionRun.findFirstOrThrow({
      where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
  }

  it("three items in a row failing with an error pause the group; the fourth is never marked; the pause lasts quietly", async () => {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const made: { id: string }[] = [];
    for (let i = 0; i < 4; i++)
      made.push(
        await mkSession({ expiresAt: ago(2 * HOUR + i * HOUR), photo: true })
      );
    await withStorage(
      async (cmd, original, opts) => {
        if (cmd instanceof DeleteObjectCommand)
          throw Object.assign(new Error("odd"), {
            name: "InternalFailure",
            $metadata: { httpStatusCode: 400 },
          });
        return original(cmd, opts);
      },
      async () => {
        await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
          /PREVIEWS paused: repeated_errors/
        );
      }
    );
    const count = () =>
      prisma.orderSession.count({
        where: {
          id: { in: made.map((m) => m.id) },
          filesDeletedAt: { not: null },
        },
      });
    expect(await count()).toBe(3);
    await expect(sweepDataDeletion(tdeps())).resolves.toBeTypeOf("number");
    expect(await count()).toBe(3);
  });

  it("a refused storage token (403) stops the run and marks nothing; the pause ends by itself when storage works again", async () => {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const s = await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    await withStorage(
      async (cmd, original, opts) => {
        if (cmd instanceof ListObjectsV2Command)
          throw Object.assign(new Error("denied"), {
            name: "AccessDenied",
            $metadata: { httpStatusCode: 403 },
          });
        return original(cmd, opts);
      },
      async () => {
        await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
          /PREVIEWS paused: storage_unreachable/
        );
      }
    );
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    await sweepDataDeletion(tdeps());
    expect((await state(s.id)).filesDeletedAt).not.toBeNull();
    expect(
      (
        await prisma.deletionGroupSetting.findUniqueOrThrow({
          where: { group: "PREVIEWS" },
        })
      ).pausedReason
    ).toBeNull();
  }, 90_000);

  it("switching to ACTIVE works with the report, the typed confirmation and a fresh canary; the old report cannot re-arm it after a mode change", async () => {
    await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await reportFor();
    expect(report.dueCount).toBe(1);
    const on = await setGroupMode(
      "PREVIEWS",
      {
        mode: "ACTIVE",
        reportRunId: report.id,
        dueCount: 1,
        confirmation: "DELETE 1",
        dailyMax: 20,
      },
      "master@example.test",
      tdeps()
    );
    expect(on).toMatchObject({
      mode: "ACTIVE",
      approvedRunId: report.id,
      dailyMax: 20,
      modeChangedByEmail: "master@example.test",
    });
    await setGroupMode(
      "PREVIEWS",
      { mode: "REPORT_ONLY" },
      "master@example.test",
      tdeps()
    );
    await expect(
      setGroupMode(
        "PREVIEWS",
        {
          mode: "ACTIVE",
          reportRunId: report.id,
          dueCount: 1,
          confirmation: "DELETE 1",
        },
        "m@example.test",
        tdeps()
      )
    ).rejects.toThrow(/changed mode/);
    await sweepDataDeletion(tdeps());
    const fresh = await prisma.deletionRun.findFirstOrThrow({
      where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    expect(fresh.id).not.toBe(report.id);
    await setGroupMode(
      "PREVIEWS",
      {
        mode: "ACTIVE",
        reportRunId: fresh.id,
        dueCount: fresh.dueCount,
        confirmation: `DELETE ${fresh.dueCount}`,
      },
      "m@example.test",
      tdeps()
    );
  });

  it("every refusal of the switch to ACTIVE", async () => {
    await mkSession({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await reportFor();
    const body = {
      mode: "ACTIVE" as const,
      reportRunId: report.id,
      dueCount: report.dueCount,
      confirmation: `DELETE ${report.dueCount}`,
    };
    const go = (b: object = body) =>
      setGroupMode("PREVIEWS", b as never, "m@example.test", tdeps());
    const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    await expect(go({ ...body, confirmation: "delete 1" })).rejects.toThrow(
      /Type DELETE/
    );
    await expect(go({ ...body, confirmation: "DELETE 99" })).rejects.toThrow(
      /Type DELETE/
    );
    await expect(go({ ...body, dueCount: 99 })).rejects.toThrow(/Type DELETE/);
    await expect(go({ mode: "ACTIVE" })).rejects.toThrow(
      /Read the latest report/
    );
    await expect(
      go({
        ...body,
        expectedModeChangedAt: new Date(
          group.modeChangedAt.getTime() - 5000
        ).toISOString(),
      })
    ).rejects.toThrow(/changed by someone else/);
    await prisma.deletionRun.update({
      where: { id: report.id },
      data: { startedAt: new Date(NOW.getTime() - 8 * DAY) },
    });
    await expect(go()).rejects.toThrow(/older than 7 days|Wait for a new/);
    await prisma.deletionRun.update({
      where: { id: report.id },
      data: { startedAt: new Date(NOW.getTime() + 10), selectionVersion: 999 },
    });
    await expect(go()).rejects.toThrow(/rules for this group changed/);
    await prisma.deletionRun.update({
      where: { id: report.id },
      data: {
        selectionVersion: SELECTION_VERSION.PREVIEWS,
        proof: { private_photo: "failed" },
      },
    });
    await expect(go()).rejects.toThrow(/storage check in this report failed/);
    await prisma.deletionRun.update({
      where: { id: report.id },
      data: { proof: {}, dueCount: 0 },
    });
    await expect(
      go({ ...body, dueCount: 0, confirmation: "DELETE 0" })
    ).rejects.toThrow(/nothing to delete/);
    await prisma.deletionRun.update({
      where: { id: report.id },
      data: { dueCount: report.dueCount },
    });
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { canaryPassedAt: ago(3 * DAY) },
    });
    await expect(go()).rejects.toThrow(/storage canary/);
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { canaryPassedAt: NOW },
    });
    await prisma.deletionRun.create({
      data: {
        group: "PREVIEWS",
        mode: "REPORT_ONLY",
        selectionVersion: SELECTION_VERSION.PREVIEWS,
        startedAt: new Date(NOW.getTime() + 60_000),
        dueCount: 1,
      },
    });
    await expect(go()).rejects.toThrow(/newer report exists/);
  });

  it("ghost rate boundaries: more than 20% and at least 3 evidenced ghosts in the window", async () => {
    const mk = async (ghosts: number, others: number) => {
      await prisma.deletionItem.deleteMany({
        where: { subjectId: { startsWith: "ghostrate-" } },
      });
      for (let i = 0; i < ghosts + others; i++) {
        await prisma.deletionItem.create({
          data: {
            subjectType: "SESSION",
            subjectId: `ghostrate-${i}`,
            scope: "SESSION",
            state: "DONE",
            ghost: i < ghosts,
            lastError: i < ghosts ? "ghost_evidenced" : null,
            claimedAt: new Date(),
          },
        });
      }
    };
    const since = new Date(Date.now() - DAY);
    await mk(2, 3);
    expect(await ghostRateExceeded(["SESSION"], since)).toBe(false);
    await mk(3, 12);
    expect(await ghostRateExceeded(["SESSION"], since)).toBe(false);
    await mk(3, 11);
    expect(await ghostRateExceeded(["SESSION"], since)).toBe(true);
    expect(
      await ghostRateExceeded(["SESSION"], new Date(Date.now() + 1000))
    ).toBe(false);
    await prisma.deletionItem.deleteMany({
      where: { subjectId: { startsWith: "ghostrate-" } },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.deletionItem.create({
        data: {
          subjectType: "SESSION",
          subjectId: `ghostrate-g${i}`,
          scope: "PAGES",
          state: "DONE",
          ghost: true,
          lastError: "ghost_evidenced",
          claimedAt: new Date(),
        },
      });
    }
    for (let i = 0; i < 30; i++) {
      await prisma.deletionItem.create({
        data: {
          subjectType: "ORDER",
          subjectId: `ghostrate-a${i}`,
          scope: "ADDRESS",
          state: "DONE",
          claimedAt: new Date(),
        },
      });
    }
    expect(await ghostRateExceeded(["PAGES", "ADDRESS"], since)).toBe(true);
    await prisma.deletionItem.deleteMany({
      where: { subjectId: { startsWith: "ghostrate-" } },
    });
  });

  it("the report lists an unpaid order whose payment was not checked apart, and never approves it", async () => {
    const old = ago(3 * DAY);
    const bad = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(2 * HOUR),
      photo: true,
      order: { updatedAt: old },
    });
    const good = await mkSession({
      status: "AWAITING_PAYMENT",
      expiresAt: ago(3 * HOUR),
      photo: true,
      order: { updatedAt: old },
    });
    const badRzp = (
      await prisma.order.findUniqueOrThrow({ where: { id: bad.orderId! } })
    ).razorpayOrderId!;
    rzp.fetchPayments.mockImplementation(async (id: string) => {
      if (id === badRzp) throw new Error("razorpay down");
      return { entity: "collection", count: 0, items: [] };
    });
    const report = await reportFor();
    const lists = report.lists as { due: string[]; blocked: string[] };
    expect(lists.due).toContain(`SESSION:${good.id}`);
    // a payment status that could not be read is recorded as a block: listed apart, never in the due list
    expect(lists.due).not.toContain(`SESSION:${bad.id}`);
    expect(lists.blocked).toContain(bad.id);
    expect(report.dueCount).toBe(1);
  });

  it("the overview carries what the admin page needs, and undo by time range clears ghosts and says when it is cut off", async () => {
    await prisma.deletionItem.deleteMany({
      where: { subjectId: "overview-failed" },
    });
    const a = await mkSession({ expiresAt: ago(2 * HOUR), ghostPhoto: true });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)}, "filesDeletedAt" = ${ago(HOUR)} WHERE "id" = ${a.id}`;
    await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: a.id,
        scope: "SESSION",
        state: "DONE",
        ghost: true,
        lastError: "ghost_evidenced",
        preCount: { private: 0, public: 0 },
        claimedAt: new Date(),
      },
    });
    await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: "overview-failed",
        scope: "PHOTO",
        state: "FAILED",
        attempts: 5,
        lastError: "verify_failed",
        claimedAt: new Date(),
      },
    });
    const overview = await getDeletionOverview();
    expect(overview.groups.map((g) => g.group)).toEqual([
      "PREVIEWS",
      "PHOTOS",
      "BOOKS",
    ]);
    const previews = overview.groups.find((g) => g.group === "PREVIEWS")!;
    expect(previews.mode).toBe("ACTIVE");
    expect(previews.items.ghostsLast24h).toBeGreaterThanOrEqual(1);
    expect(
      previews.attention.some((i) => i.subjectId === a.id && i.ghost)
    ).toBe(true);
    const photos = overview.groups.find((g) => g.group === "PHOTOS")!;
    expect(photos.items.failed).toBeGreaterThanOrEqual(1);
    expect(overview.canary).toHaveProperty("passedAt");
    expect(typeof overview.paidAfterDeletionOrders).toBe("number");
    const result = await undoGhosts(
      {
        from: new Date(Date.now() - DAY).toISOString(),
        to: new Date(Date.now() + DAY).toISOString(),
      },
      tdeps()
    );
    expect(result.undone).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(false);
    expect((await state(a.id)).filesDeletedAt).toBeNull();
    await prisma.deletionItem.deleteMany({
      where: { subjectId: "overview-failed" },
    });
  });

  it("purge removes only what is old: done items after 90 days (address and comic ones by their done time), blocks after a day, runs after 90 days except the approved and the latest", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 100 * DAY);
    const fresh = new Date(now.getTime() - 10 * DAY);
    const mkItem = (id: string, scope: "SESSION" | "ADDRESS", extra: object) =>
      prisma.deletionItem.create({
        data: {
          subjectType: "SESSION",
          subjectId: `purge-${id}`,
          scope,
          state: "DONE",
          ...extra,
        },
      });
    await mkItem("old-reverified", "SESSION", {
      reverifiedAt: old,
      doneAt: old,
    });
    await mkItem("fresh-reverified", "SESSION", {
      reverifiedAt: fresh,
      doneAt: fresh,
    });
    await mkItem("old-address", "ADDRESS", { doneAt: old });
    await mkItem("fresh-address", "ADDRESS", { doneAt: fresh });
    await prisma.deletionBlock.create({
      data: {
        subjectId: "purge-block-old",
        reason: "clear",
        checkedAt: new Date(now.getTime() - 2 * DAY),
      },
    });
    await prisma.deletionBlock.create({
      data: { subjectId: "purge-block-new", reason: "clear", checkedAt: now },
    });
    const runBase = {
      group: "PHOTOS" as const,
      mode: "REPORT_ONLY" as const,
      selectionVersion: 1,
    };
    const oldRun = await prisma.deletionRun.create({
      data: { ...runBase, startedAt: old },
    });
    const approvedRun = await prisma.deletionRun.create({
      data: { ...runBase, startedAt: new Date(old.getTime() - DAY) },
    });
    const latestRun = await prisma.deletionRun.create({
      data: { ...runBase, startedAt: fresh },
    });
    await prisma.deletionGroupSetting.update({
      where: { group: "PHOTOS" },
      data: { approvedRunId: approvedRun.id },
    });
    await purgeOldRows(now, true);
    const has = async (id: string) =>
      !!(await prisma.deletionItem.findFirst({
        where: { subjectId: `purge-${id}` },
      }));
    expect(await has("old-reverified")).toBe(false);
    expect(await has("fresh-reverified")).toBe(true);
    expect(await has("old-address")).toBe(false);
    expect(await has("fresh-address")).toBe(true);
    expect(
      await prisma.deletionBlock.findUnique({
        where: { subjectId: "purge-block-old" },
      })
    ).toBeNull();
    expect(
      await prisma.deletionBlock.findUnique({
        where: { subjectId: "purge-block-new" },
      })
    ).not.toBeNull();
    expect(
      await prisma.deletionRun.findUnique({ where: { id: oldRun.id } })
    ).toBeNull();
    expect(
      await prisma.deletionRun.findUnique({ where: { id: approvedRun.id } })
    ).not.toBeNull();
    expect(
      await prisma.deletionRun.findUnique({ where: { id: latestRun.id } })
    ).not.toBeNull();
    await prisma.deletionGroupSetting.update({
      where: { group: "PHOTOS" },
      data: { approvedRunId: null },
    });
    await prisma.deletionItem.deleteMany({
      where: { subjectId: { startsWith: "purge-" } },
    });
    await prisma.deletionBlock.deleteMany({
      where: { subjectId: { startsWith: "purge-" } },
    });
  });

  it("a marker written while the database session runs in another time zone still stores the injected UTC clock", async () => {
    const s = await mkSession({ expiresAt: ago(2 * HOUR) });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
      await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${NOW} WHERE "id" = ${s.id}`;
    });
    expect((await state(s.id)).photoDeletedAt?.toISOString()).toBe(
      NOW.toISOString()
    );
  });
});
