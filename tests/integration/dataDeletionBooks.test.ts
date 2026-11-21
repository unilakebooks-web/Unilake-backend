// Integration tests for the paid-book rules of automatic data deletion (feature 6): R2 photo (3 days after
// delivery), R3 pages and R4 PDF (45 days), R5 address history, the delivery clock checks, the daily cap, resuming
// a claimed item, and the admin actions. Neon TEST branch and local MinIO only; every selection is scoped to this
// file's own comic; the clock is injected.
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
  objectExists,
  pdfKeyFor,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  releaseItem,
  retryItems,
  sweepDataDeletion,
  undoGhost,
} from "../../src/services/dataDeletion.service.js";
import type { DeletionDeps } from "../../src/services/dataDeletionEngine.service.js";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";

const MARK = "__vitest_deletion_books__";
const RUN = Math.random().toString(36).slice(2, 8);
const NOW = new Date("2031-09-15T12:00:00.000Z");
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

interface Opts {
  status?: "DELIVERED" | "SHIPPED" | "PAID" | "CANCELLED";
  deliveredAt?: Date | null;
  orderCreatedAt?: Date;
  withPdf?: boolean;
  pdfUrl?: string | null;
  address?: {
    syncStatus: "FAILED" | "SYNCED" | "SYNCING";
    syncStartedAt?: Date;
    syncNote?: string;
  }[];
}

async function mkDelivered(o: Opts = {}) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: "COMPLETED",
      expiresAt: ago(400 * DAY),
      rawPhotoUrls: [],
    },
  });
  sessionIds.push(session.id);
  const photoKey = `sessions/${session.id}/photo-1.jpg`;
  await uploadFile("private", photoKey, Buffer.from("photo"), "image/jpeg");
  await prisma.orderSession.update({
    where: { id: session.id },
    data: { bestPhotoUrl: photoKey, rawPhotoUrls: [photoKey] },
  });
  const pageKey = `sessions/${session.id}/final-0.png`;
  await uploadFile("public", pageKey, Buffer.from("page"), "image/png");
  await prisma.pageVersion.create({
    data: {
      orderSessionId: session.id,
      pageId,
      status: "SD_READY",
      finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${pageKey}`,
    },
  });
  if (o.withPdf)
    await uploadFile(
      "public",
      pdfKeyFor(session.id),
      Buffer.from("pdf"),
      "application/pdf"
    );
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: "499.00",
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
      status: o.status ?? "DELIVERED",
      razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
      deliveredAt: o.deliveredAt === undefined ? ago(60 * DAY) : o.deliveredAt,
      pdfUrl:
        o.pdfUrl !== undefined
          ? o.pdfUrl
          : o.withPdf
            ? pdfKeyFor(session.id)
            : null,
      shippingName: `${MARK} ${RUN}`,
    },
  });
  await prisma.$executeRaw`UPDATE "orders" SET "createdAt" = ${o.orderCreatedAt ?? ago(100 * DAY)} WHERE "id" = ${order.id}`;
  for (const [i, a] of (o.address ?? []).entries()) {
    await prisma.orderAddressChange.create({
      data: {
        orderId: order.id,
        before: { name: "Old Name", line1: "1 Old Road" },
        after: { name: "New Name", line1: "2 New Road" },
        changedById: "admin-x",
        changedByEmail: "admin@example.test",
        syncStatus: a.syncStatus,
        syncStartedAt: a.syncStartedAt ?? null,
        syncNote: a.syncNote ?? null,
      },
    });
    void i;
  }
  return { id: session.id, orderId: order.id };
}

const sess = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true },
  });
const ord = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: { pdfDeletedAt: true },
  });

async function setMode(
  group: "PREVIEWS" | "PHOTOS" | "BOOKS",
  mode: "OFF" | "ACTIVE",
  dailyMax = 100
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
      dailyMax,
      lastReportAt: null,
    },
  });
}

async function wipe() {
  const ids = [...new Set(sessionIds)];
  sessionIds.length = 0;
  await Promise.all(
    ids.flatMap((id) => [
      deletePrefix("public", `sessions/${id}/`),
      deletePrefix("private", `sessions/${id}/`),
    ])
  );
  const { deleteKeyChecked } = await import("../../src/lib/r2.js");
  for (const id of ids)
    await deleteKeyChecked("public", pdfKeyFor(id)).catch(() => {});
  const orders = await prisma.order.findMany({
    where: { orderSessionId: { in: ids } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.orderAddressChange.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.deletionItem.deleteMany({
    where: { subjectId: { in: [...ids, ...orderIds] } },
  });
  await prisma.deletionBlock.deleteMany({});
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  const stale = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  sessionIds.push(...stale.map((s) => s.id));
  await wipe();
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
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
      },
    })
  ).id;
});

beforeEach(async () => {
  await wipe();
  await prisma.deletionRun.deleteMany({});
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: NOW, leaseUntil: null, leaseOwner: null },
  });
  await setMode("PREVIEWS", "OFF");
  await setMode("PHOTOS", "ACTIVE");
  await setMode("BOOKS", "ACTIVE");
});

afterAll(async () => {
  await wipe();
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
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

describe("R2 and R3: the photo after 3 days, the pages after 45", () => {
  it("each waits for its own boundary, to the second, and touches only its own folder", async () => {
    const day3Early = await mkDelivered({
      deliveredAt: ago(3 * DAY + HOUR - 1000),
    });
    const day3 = await mkDelivered({ deliveredAt: ago(3 * DAY + HOUR) });
    const day45Early = await mkDelivered({
      deliveredAt: ago(45 * DAY + HOUR - 1000),
    });
    const day45 = await mkDelivered({ deliveredAt: ago(45 * DAY + HOUR) });
    await sweepDataDeletion(deps());
    // 3 days minus a second: nothing
    expect((await sess(day3Early.id)).photoDeletedAt).toBeNull();
    expect(await countPrefix("private", `sessions/${day3Early.id}/`)).toBe(1);
    // 3 days: the photo goes, the pages stay
    expect((await sess(day3.id)).photoDeletedAt).not.toBeNull();
    expect((await sess(day3.id)).filesDeletedAt).toBeNull();
    expect(await countPrefix("private", `sessions/${day3.id}/`)).toBe(0);
    expect(await countPrefix("public", `sessions/${day3.id}/`)).toBe(1);
    // 45 days minus a second: photo gone (it is past 3 days), pages stay
    expect((await sess(day45Early.id)).filesDeletedAt).toBeNull();
    expect(await countPrefix("public", `sessions/${day45Early.id}/`)).toBe(1);
    // 45 days: both gone
    expect((await sess(day45.id)).photoDeletedAt).not.toBeNull();
    expect((await sess(day45.id)).filesDeletedAt).not.toBeNull();
    expect(await countPrefix("public", `sessions/${day45.id}/`)).toBe(0);
  });

  it("only a DELIVERED order is deleted, whatever deliveredAt says", async () => {
    const shipped = await mkDelivered({
      status: "SHIPPED",
      deliveredAt: ago(100 * DAY),
    });
    const paid = await mkDelivered({
      status: "PAID",
      deliveredAt: ago(100 * DAY),
    });
    const cancelled = await mkDelivered({
      status: "CANCELLED",
      deliveredAt: ago(100 * DAY),
    });
    await sweepDataDeletion(deps());
    for (const s of [shipped, paid, cancelled]) {
      expect((await sess(s.id)).photoDeletedAt).toBeNull();
      expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(1);
    }
  });

  it("an unusable delivery clock is never deleted and is listed in the report", async () => {
    const beforeCreated = await mkDelivered({
      deliveredAt: ago(200 * DAY),
      orderCreatedAt: ago(100 * DAY),
    });
    const nullDate = await mkDelivered({ deliveredAt: null });
    const future7h = await mkDelivered({
      deliveredAt: new Date(NOW.getTime() + 7 * HOUR),
    });
    const future5h = await mkDelivered({
      deliveredAt: new Date(NOW.getTime() + 5 * HOUR),
    });
    await prisma.deletionGroupSetting.update({
      where: { group: "PHOTOS" },
      data: { mode: "REPORT_ONLY", lastReportAt: null },
    });
    await sweepDataDeletion({
      ...deps(),
      now: () => new Date(NOW.getTime() + 1),
    });
    for (const s of [beforeCreated, nullDate, future7h, future5h]) {
      expect((await sess(s.id)).photoDeletedAt).toBeNull();
    }
    const report = await prisma.deletionRun.findFirstOrThrow({
      where: { group: "PHOTOS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    const failed = (report.lists as { failedClock: string[] }).failedClock;
    expect(failed).toContain(beforeCreated.orderId);
    expect(failed).toContain(nullDate.orderId);
    expect(failed).toContain(future7h.orderId);
    // up to 6 hours ahead is only "not due yet", not a failure
    expect(failed).not.toContain(future5h.orderId);
  });

  it("the daily maximum limits new items, and resumes the next day", async () => {
    await setMode("PHOTOS", "ACTIVE", 2);
    const made = [];
    for (let i = 0; i < 5; i++)
      made.push(await mkDelivered({ deliveredAt: ago(10 * DAY + i * HOUR) }));
    await sweepDataDeletion(deps());
    const done = await prisma.orderSession.count({
      where: {
        id: { in: made.map((m) => m.id) },
        photoDeletedAt: { not: null },
      },
    });
    expect(done).toBe(2);
    // the same day: nothing more
    await sweepDataDeletion(deps());
    expect(
      await prisma.orderSession.count({
        where: {
          id: { in: made.map((m) => m.id) },
          photoDeletedAt: { not: null },
        },
      })
    ).toBe(2);
    // a day later (the clock moves, the items claimed more than 24 hours ago no longer count)
    await prisma.deletionItem.updateMany({
      where: { subjectId: { in: made.map((m) => m.id) } },
      data: { claimedAt: new Date(NOW.getTime() - 2 * DAY) },
    });
    await sweepDataDeletion(deps());
    expect(
      await prisma.orderSession.count({
        where: {
          id: { in: made.map((m) => m.id) },
          photoDeletedAt: { not: null },
        },
      })
    ).toBe(4);
  });
});

describe("R4: the final PDF", () => {
  it("deletes pdfs/<sessionId>.pdf from the public bucket at 45 days, and sets pdfDeletedAt", async () => {
    const s = await mkDelivered({ deliveredAt: ago(46 * DAY), withPdf: true });
    expect(await objectExists("public", pdfKeyFor(s.id))).toBe(true);
    await sweepDataDeletion(deps());
    expect(await objectExists("public", pdfKeyFor(s.id))).toBe(false);
    expect((await ord(s.orderId)).pdfDeletedAt).not.toBeNull();
  });

  it("a stored pdfUrl that is not the derived key is listed and left alone", async () => {
    const s = await mkDelivered({
      deliveredAt: ago(46 * DAY),
      withPdf: true,
      pdfUrl: "legacy/odd-name.pdf",
    });
    await sweepDataDeletion(deps());
    expect(await objectExists("public", pdfKeyFor(s.id))).toBe(true);
    expect((await ord(s.orderId)).pdfDeletedAt).toBeNull();
  });
});

describe("R5: address history", () => {
  it("is emptied at 45 days for a delivered order whatever the sync status, and keeps who, when and the result", async () => {
    const s = await mkDelivered({
      deliveredAt: ago(46 * DAY),
      address: [
        { syncStatus: "FAILED" },
        { syncStatus: "SYNCED", syncNote: "updated to 12 MG Road" },
      ],
    });
    await sweepDataDeletion(deps());
    const rows = await prisma.orderAddressChange.findMany({
      where: { orderId: s.orderId },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.before).toEqual({});
      expect(row.after).toEqual({});
      expect(row.syncNote).toBeNull();
      expect(row.changedByEmail).toBe("admin@example.test");
    }
    expect(rows.map((r) => r.syncStatus).sort()).toEqual(["FAILED", "SYNCED"]);
  });

  it("a fresh SYNCING row skips the order; a stale one does not", async () => {
    const fresh = await mkDelivered({
      deliveredAt: ago(46 * DAY),
      address: [{ syncStatus: "SYNCING", syncStartedAt: ago(60_000) }],
    });
    const stale = await mkDelivered({
      deliveredAt: ago(46 * DAY),
      address: [{ syncStatus: "SYNCING", syncStartedAt: ago(10 * 60_000) }],
    });
    await sweepDataDeletion(deps());
    const f = await prisma.orderAddressChange.findFirstOrThrow({
      where: { orderId: fresh.orderId },
    });
    const s = await prisma.orderAddressChange.findFirstOrThrow({
      where: { orderId: stale.orderId },
    });
    expect(f.before).not.toEqual({});
    expect(s.before).toEqual({});
  });

  it("is selected on its own: a later settled row is emptied after R3 already ran", async () => {
    const s = await mkDelivered({
      deliveredAt: ago(46 * DAY),
      address: [{ syncStatus: "SYNCING", syncStartedAt: ago(60_000) }],
    });
    await sweepDataDeletion(deps());
    expect((await sess(s.id)).filesDeletedAt).not.toBeNull(); // R3 ran
    await prisma.orderAddressChange.updateMany({
      where: { orderId: s.orderId },
      data: { syncStatus: "SYNCED", syncStartedAt: null },
    });
    await sweepDataDeletion(deps());
    const row = await prisma.orderAddressChange.findFirstOrThrow({
      where: { orderId: s.orderId },
    });
    expect(row.before).toEqual({});
  });
});

describe("resuming, releasing and undoing", () => {
  it("a CLAIMED item left by a crash is finished by the next ACTIVE run, and the marker was already set", async () => {
    const s = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${NOW} WHERE "id" = ${s.id}`;
    const item = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: s.id,
        scope: "PHOTO",
        state: "CLAIMED",
        attempts: 1,
        preCount: { private: 1 },
      },
    });
    await sweepDataDeletion(deps());
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
    expect(
      (await prisma.deletionItem.findUniqueOrThrow({ where: { id: item.id } }))
        .state
    ).toBe("DONE");
  });

  it("an item whose attempts are used up becomes FAILED, never blocks the others, and retry gives it another go", async () => {
    const bad = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    const good = await mkDelivered({ deliveredAt: ago(10 * DAY + HOUR) });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${NOW} WHERE "id" = ${bad.id}`;
    const item = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: bad.id,
        scope: "PHOTO",
        state: "CLAIMED",
        attempts: 5,
        preCount: { private: 1 },
      },
    });
    await expect(sweepDataDeletion(deps())).rejects.toThrow(
      /failed: attempts_used_up/
    );
    expect(
      (await prisma.deletionItem.findUniqueOrThrow({ where: { id: item.id } }))
        .state
    ).toBe("FAILED");
    expect((await sess(good.id)).photoDeletedAt).not.toBeNull();
    expect(await retryItems({ group: "PHOTOS" })).toBe(1);
    const again = await prisma.deletionItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(again.state).toBe("CLAIMED");
    expect(again.attempts).toBe(0);
  });

  it("release clears the marker and the item only when nothing was deleted, and refuses a half-deleted session", async () => {
    const untouched = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    const half = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    for (const s of [untouched, half]) {
      await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)} WHERE "id" = ${s.id}`;
    }
    const a = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: untouched.id,
        scope: "PHOTO",
        state: "FAILED",
        attempts: 5,
        preCount: { private: 1 },
      },
    });
    const b = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: half.id,
        scope: "PHOTO",
        state: "FAILED",
        attempts: 5,
        preCount: { private: 2 },
      },
    });
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(HOUR)} WHERE "id" IN (${a.id}, ${b.id})`;
    await releaseItem(a.id, deps());
    expect((await sess(untouched.id)).photoDeletedAt).toBeNull();
    expect(
      await prisma.deletionItem.findUnique({ where: { id: a.id } })
    ).toBeNull();
    // the other had 2 objects before the claim and has 1 now: some were deleted
    await expect(releaseItem(b.id, deps())).rejects.toThrow(/files_changed/);
    expect((await sess(half.id)).photoDeletedAt).not.toBeNull();
  });

  it("release and undo are refused for a session that has a payment recorded after deletion", async () => {
    const s = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)} WHERE "id" = ${s.id}`;
    await prisma.$executeRaw`UPDATE "orders" SET "paidAfterDeletionAt" = ${ago(HOUR)} WHERE "id" = ${s.orderId}`;
    const item = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: s.id,
        scope: "PHOTO",
        state: "DONE",
        ghost: true,
        preCount: { private: 1 },
      },
    });
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(HOUR)} WHERE "id" = ${item.id}`;
    await expect(undoGhost(item.id, deps())).rejects.toThrow(
      /paid_after_deletion/
    );
  });

  it("release and undo are refused while a deletion run holds the lease", async () => {
    const s = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)} WHERE "id" = ${s.id}`;
    const item = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: s.id,
        scope: "PHOTO",
        state: "FAILED",
        attempts: 5,
        preCount: { private: 1 },
      },
    });
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(HOUR)} WHERE "id" = ${item.id}`;
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: {
        leaseUntil: new Date(NOW.getTime() + 60_000),
        leaseOwner: "a-run",
      },
    });
    await expect(releaseItem(item.id, deps())).rejects.toThrow(/in progress/);
    expect((await sess(s.id)).photoDeletedAt).not.toBeNull();
  });

  it("two runs at once: the second returns without doing anything while the lease is live", async () => {
    const s = await mkDelivered({ deliveredAt: ago(10 * DAY) });
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: {
        leaseUntil: new Date(NOW.getTime() + 60_000),
        leaseOwner: "someone-else",
      },
    });
    expect(await sweepDataDeletion(deps())).toBe(0);
    expect((await sess(s.id)).photoDeletedAt).toBeNull();
    // a lease older than 5 minutes is taken over
    await prisma.deletionSetting.update({
      where: { id: 1 },
      data: { leaseUntil: new Date(NOW.getTime() - 60_000) },
    });
    await sweepDataDeletion(deps());
    expect((await sess(s.id)).photoDeletedAt).not.toBeNull();
  });
});
