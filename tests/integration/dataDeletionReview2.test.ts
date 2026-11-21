// Integration tests for the second pull request review of automatic data deletion (feature 6): the atomic and
// fail-closed switch to ACTIVE, the backlog log lines, resumed ghosts, the payment guard for an ineligible preview,
// lease renewal, the storage probe, the per-batch deadline and the extra report lists. Neon TEST branch and local
// MinIO only; the clock is injected; every selection is scoped to this file's own comic.
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
import { logger } from "../../src/lib/logger.js";
import { config } from "../../src/config/env.js";
import {
  countPrefix,
  deleteKeyChecked,
  deletePrefix,
  pdfKeyFor,
  r2Client,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  getDeletionOverview,
  setGroupMode,
  sweepDataDeletion,
  undoGhosts,
} from "../../src/services/dataDeletion.service.js";
import {
  acquireLease,
  createRunContext,
  gatherPaymentVerdict,
  processCandidate,
  releaseLease,
  renewLease,
  type DeletionDeps,
} from "../../src/services/dataDeletionEngine.service.js";
import { selectReportLists } from "../../src/services/dataDeletionSelect.service.js";
import {
  LEASE_STALE_MS,
  SELECTION_VERSION,
} from "../../src/config/dataDeletion.js";

const MARK = "__vitest_deletion_review2__";
const RUN = Math.random().toString(36).slice(2, 8);
const NOW = new Date("2032-03-15T12:00:00.000Z");
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
// Runs and reports sort by their start time: the clock moves a millisecond per call so two never tie.
let tick = 0;
const tdeps = (): DeletionDeps => ({
  ...deps(),
  now: () => new Date(NOW.getTime() + ++tick),
});
const sessionIds: string[] = [];

interface Opts {
  expiresAt?: Date;
  /** A real photo object (and the recorded key). */
  photo?: boolean;
  /** A recorded photo key with no object. */
  ghostPhoto?: boolean;
  /** Extra objects in the private folder of the session. */
  extra?: number;
  /** An SD_READY page of a face page, so the photo counts as evidence. */
  evidence?: boolean;
  order?: {
    status: "CREATED" | "DELIVERED" | "GENERATED";
    deliveredAt?: Date;
    updatedAt?: Date;
    razorpayPaymentId?: string;
    pdf?: "file" | "ghost";
    awbNumber?: string;
  };
}

async function mk(o: Opts = {}) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: o.order?.status === "DELIVERED" ? "COMPLETED" : "PREVIEW_READY",
      // Not due for R1 unless a test says so (an old preview would be taken by the PREVIEWS group first).
      expiresAt: o.expiresAt ?? new Date(NOW.getTime() + 30 * DAY),
      rawPhotoUrls: [],
    },
  });
  sessionIds.push(session.id);
  await prisma.$executeRaw`UPDATE "order_sessions" SET "createdAt" = ${ago(30 * DAY)} WHERE "id" = ${session.id}`;
  if (o.photo || o.ghostPhoto) {
    const key = `sessions/${session.id}/photo-1.jpg`;
    if (o.photo)
      await uploadFile("private", key, Buffer.from("photo"), "image/jpeg");
    await prisma.orderSession.update({
      where: { id: session.id },
      data: { bestPhotoUrl: key, rawPhotoUrls: [key] },
    });
  }
  for (let n = 0; n < (o.extra ?? 0); n++)
    await uploadFile(
      "private",
      `sessions/${session.id}/extra-${n}.jpg`,
      Buffer.from("x"),
      "image/jpeg"
    );
  if (o.evidence) {
    const key = `sessions/${session.id}/final-0.png`;
    await uploadFile("public", key, Buffer.from("page"), "image/png");
    await prisma.pageVersion.create({
      data: {
        orderSessionId: session.id,
        pageId,
        status: "SD_READY",
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
      },
    });
  }
  let orderId: string | null = null;
  if (o.order) {
    if (o.order.pdf === "file")
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
        status: o.order.status,
        razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
        razorpayPaymentId: o.order.razorpayPaymentId,
        deliveredAt: o.order.deliveredAt ?? null,
        awbNumber: o.order.awbNumber,
        pdfUrl: o.order.pdf ? pdfKeyFor(session.id) : null,
        shippingName: `${MARK} ${RUN}`,
      },
    });
    orderId = order.id;
    await prisma.$executeRaw`UPDATE "orders" SET "createdAt" = ${ago(100 * DAY)}, "updatedAt" = ${o.order.updatedAt ?? ago(100 * DAY)} WHERE "id" = ${order.id}`;
  }
  return { id: session.id, orderId };
}

const state = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true },
  });

async function setMode(
  group: "PREVIEWS" | "PHOTOS" | "BOOKS",
  mode: "OFF" | "REPORT_ONLY" | "ACTIVE",
  extra: Record<string, unknown> = {}
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
      ...extra,
    },
  });
}

async function wipe() {
  const stale = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  sessionIds.push(...stale.map((s) => s.id));
  const ids = [...new Set(sessionIds)];
  sessionIds.length = 0;
  await Promise.all(
    ids.flatMap((id) => [
      deletePrefix("public", `sessions/${id}/`),
      deletePrefix("private", `sessions/${id}/`),
    ])
  );
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
    where: {
      subjectId: {
        in: [...ids, ...orderIds, "review2-old-a", "review2-old-b"],
      },
    },
  });
  await prisma.deletionBlock.deleteMany({});
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await wipe();
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
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
  vi.restoreAllMocks();
  await wipe();
  await prisma.deletionRun.deleteMany({});
  rzp.fetchPayments.mockClear();
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: NOW, leaseUntil: null, leaseOwner: null },
  });
  await setMode("PREVIEWS", "ACTIVE");
  await setMode("PHOTOS", "OFF");
  await setMode("BOOKS", "OFF");
});

afterAll(async () => {
  await wipe();
  await prisma.deletionRun.deleteMany({});
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { leaseUntil: null, leaseOwner: null },
  });
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

const errorLines = (spy: { mock: { calls: unknown[][] } }, text: RegExp) =>
  spy.mock.calls.filter(
    (call) => typeof call[1] === "string" && text.test(call[1] as string)
  );

async function previewReport() {
  await setMode("PREVIEWS", "REPORT_ONLY");
  await sweepDataDeletion(tdeps());
  return prisma.deletionRun.findFirstOrThrow({
    where: { group: "PREVIEWS", mode: "REPORT_ONLY" },
    orderBy: { startedAt: "desc" },
  });
}

describe("the switch to ACTIVE is atomic and the approved set fails closed", () => {
  const activate = (report: { id: string; dueCount: number }) =>
    setGroupMode(
      "PREVIEWS",
      {
        mode: "ACTIVE",
        reportRunId: report.id,
        dueCount: report.dueCount,
        confirmation: `DELETE ${report.dueCount}`,
      },
      "m@example.test",
      tdeps()
    );

  it("is refused while a deletion run holds the lease, and the lease is released after a refusal and after a success", async () => {
    await mk({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await previewReport();
    const owner = await acquireLease(tdeps());
    await expect(activate(report)).rejects.toThrow(/run is in progress/);
    await releaseLease(owner!);
    await expect(
      setGroupMode(
        "PREVIEWS",
        { mode: "ACTIVE", reportRunId: report.id, dueCount: 99 },
        "m@example.test",
        tdeps()
      )
    ).rejects.toThrow(/Type DELETE/);
    const row = () =>
      prisma.deletionSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect((await row()).leaseOwner).toBeNull();
    await activate(report);
    expect((await row()).leaseOwner).toBeNull();
  });

  it("fails when the group changed between the read and the write, and changes nothing", async () => {
    await mk({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await previewReport();
    const before = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    const delegate = prisma.deletionRun as unknown as {
      findFirst: (...args: unknown[]) => Promise<unknown>;
    };
    const real = delegate.findFirst;
    // Someone else changes the group (a pause, a switch) after the switch read it, before it writes.
    delegate.findFirst = async (...args: unknown[]) => {
      delegate.findFirst = real;
      await prisma.deletionGroupSetting.update({
        where: { group: "PREVIEWS" },
        data: { modeChangedAt: new Date(NOW.getTime() + 60_000) },
      });
      return real.apply(prisma.deletionRun, args);
    };
    try {
      await expect(activate(report)).rejects.toThrow(/changed by someone else/);
    } finally {
      delegate.findFirst = real;
    }
    const after = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    expect(after.mode).toBe("REPORT_ONLY");
    expect(after.approvedRunId).toBeNull();
    expect(before.mode).toBe("REPORT_ONLY");
  });

  it("is refused when the report's lists are gone", async () => {
    await mk({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await previewReport();
    await prisma.$executeRaw`UPDATE "deletion_runs" SET "lists" = NULL WHERE "id" = ${report.id}`;
    await expect(activate(report)).rejects.toThrow(/no longer stored/);
  });

  it("a running group whose approved report or list is gone pauses instead of starting steady state", async () => {
    const s = await mk({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await previewReport();
    const approve = (runId: string) =>
      setMode("PREVIEWS", "ACTIVE", {
        approvedRunId: runId,
        approvedAt: NOW,
        approvalExhaustedAt: null,
        modeChangedAt: ago(DAY),
      });
    // The list was emptied.
    await prisma.$executeRaw`UPDATE "deletion_runs" SET "lists" = NULL WHERE "id" = ${report.id}`;
    await approve(report.id);
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
      /PREVIEWS paused: approved_report_missing/
    );
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
      where: { group: "PREVIEWS" },
    });
    expect(group.mode).toBe("REPORT_ONLY");
    expect(group.pausedReason).toBe("approved_report_missing");
    expect(group.approvalExhaustedAt).toBeNull();
    // The run itself is gone.
    await approve("00000000-0000-4000-8000-000000000000");
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
      /PREVIEWS paused: approved_report_missing/
    );
    expect((await state(s.id)).filesDeletedAt).toBeNull();
  });
});

describe("backlog and stuck items are logged at error level", () => {
  it("one line per run for an item FAILED or CLAIMED over 24 hours, with the count and the oldest age", async () => {
    const spy = vi.spyOn(logger, "error");
    const a = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: "review2-old-a",
        scope: "PHOTO",
        state: "FAILED",
        attempts: 5,
        claimedAt: ago(3 * DAY),
      },
    });
    const b = await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: "review2-old-b",
        scope: "PAGES",
        state: "CLAIMED",
        attempts: 1,
        lastErrorAt: ago(5 * HOUR),
        claimedAt: ago(30 * HOUR),
      },
    });
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(50 * HOUR)} WHERE "id" = ${a.id}`;
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(HOUR)} WHERE "id" = ${b.id}`;
    // A run in which PREVIEWS is ACTIVE (the stuck items belong to groups that are OFF: the line covers them too).
    await sweepDataDeletion(tdeps());
    const lines = errorLines(spy, /CLAIMED or FAILED for over 24 hours/);
    expect(lines).toHaveLength(1);
    const fields = lines[0]![0] as { count: number; oldestAgeHours: number };
    expect(fields.count).toBeGreaterThanOrEqual(2);
    expect(fields.oldestAgeHours).toBeGreaterThanOrEqual(50);
    // Under 24 hours: no line.
    spy.mockClear();
    await prisma.$executeRaw`UPDATE "deletion_items" SET "updatedAt" = ${ago(HOUR)}, "claimedAt" = ${ago(HOUR)} WHERE "id" IN (${a.id}, ${b.id})`;
    await sweepDataDeletion(tdeps());
    const again = errorLines(spy, /CLAIMED or FAILED for over 24 hours/);
    for (const line of again)
      expect((line[0] as { count: number }).count).not.toBe(2);
  });

  it("in steady state the oldest due item over 24 hours past due is logged, also when the daily maximum is used up", async () => {
    const spy = vi.spyOn(logger, "error");
    await mk({ expiresAt: ago(2 * HOUR), photo: true });
    await sweepDataDeletion(tdeps());
    expect(errorLines(spy, /past due/)).toHaveLength(0);
    await mk({ expiresAt: ago(3 * DAY), photo: true });
    await setMode("PREVIEWS", "ACTIVE", { dailyMax: 1 });
    // Use up the daily maximum first: the backlog is then exactly what dailyMax holds back.
    for (const id of ["review2-old-a", "review2-old-b"])
      await prisma.deletionItem.create({
        data: {
          subjectType: "SESSION",
          subjectId: id,
          scope: "SESSION",
          state: "DONE",
          claimedAt: NOW,
          doneAt: NOW,
        },
      });
    await sweepDataDeletion(tdeps());
    const lines = errorLines(spy, /past due/);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const fields = lines[0]![0] as { group: string; oldestDueAgeHours: number };
    expect(fields.group).toBe("PREVIEWS");
    expect(fields.oldestDueAgeHours).toBeGreaterThanOrEqual(71);
  });

  it("with room left, an old due item is logged before it is deleted", async () => {
    const spy = vi.spyOn(logger, "error");
    const old = await mk({ expiresAt: ago(3 * DAY), photo: true });
    await sweepDataDeletion(tdeps());
    expect(errorLines(spy, /past due/).length).toBeGreaterThanOrEqual(1);
    expect((await state(old.id)).filesDeletedAt).not.toBeNull();
  });

  it("during the first run, an item due outside the approved report for over 2 days is logged; a younger one is not", async () => {
    const spy = vi.spyOn(logger, "error");
    const approved = await mk({ expiresAt: ago(2 * HOUR), photo: true });
    const report = await previewReport();
    const young = await mk({ expiresAt: ago(DAY + HOUR), photo: true });
    await setMode("PREVIEWS", "ACTIVE", {
      approvedRunId: report.id,
      approvedAt: NOW,
      approvalExhaustedAt: null,
      modeChangedAt: ago(DAY),
    });
    await sweepDataDeletion(tdeps());
    expect(errorLines(spy, /outside the approved report/)).toHaveLength(0);
    expect((await state(approved.id)).filesDeletedAt).not.toBeNull();
    expect((await state(young.id)).filesDeletedAt).toBeNull();
    const old = await mk({ expiresAt: ago(5 * DAY), photo: true });
    await setMode("PREVIEWS", "ACTIVE", {
      approvedRunId: report.id,
      approvedAt: NOW,
      approvalExhaustedAt: null,
      modeChangedAt: ago(DAY),
    });
    // The approved item is already done, so only an unsettled approved item would hold the restriction: add one.
    await prisma.deletionItem.deleteMany({ where: { subjectId: approved.id } });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = NULL, "filesDeletedAt" = NULL WHERE "id" = ${approved.id}`;
    await uploadFile(
      "private",
      `sessions/${approved.id}/photo-1.jpg`,
      Buffer.from("photo"),
      "image/jpeg"
    );
    spy.mockClear();
    await sweepDataDeletion(tdeps());
    const lines = errorLines(spy, /outside the approved report/);
    expect(lines).toHaveLength(1);
    const fields = lines[0]![0] as { count: number; oldestDueAgeHours: number };
    expect(fields.count).toBeGreaterThanOrEqual(1);
    expect(fields.oldestDueAgeHours).toBeGreaterThanOrEqual(119);
    expect((await state(old.id)).filesDeletedAt).toBeNull();
  });

  it("the overview carries the oldest due age of an ACTIVE group", async () => {
    await mk({ expiresAt: ago(3 * DAY), photo: true });
    const overview = await getDeletionOverview(deps());
    const previews = overview.groups.find((g) => g.group === "PREVIEWS")!;
    expect(previews.oldestDueAt).toBeInstanceOf(Date);
    expect(
      NOW.getTime() - previews.oldestDueAt!.getTime()
    ).toBeGreaterThanOrEqual(3 * DAY);
    const photos = overview.groups.find((g) => g.group === "PHOTOS")!;
    expect(photos.oldestDueAt).toBeNull();
  });
});

describe("a resumed item takes the same ghost checks and bucket proof as a new one", () => {
  async function claimedPhotoGhost() {
    const ghost = await mk({
      ghostPhoto: true,
      order: { status: "DELIVERED", deliveredAt: ago(10 * DAY) },
    });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)} WHERE "id" = ${ghost.id}`;
    await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: ghost.id,
        scope: "PHOTO",
        state: "CLAIMED",
        attempts: 1,
        preCount: { private: 0 },
        claimedAt: ago(HOUR),
      },
    });
    return ghost;
  }
  const photoItem = (id: string) =>
    prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: id, scope: "PHOTO" } },
    });

  it("with a proof candidate the ghost is DONE and flagged", async () => {
    await mk({ photo: true, evidence: true });
    const ghost = await claimedPhotoGhost();
    await setMode("PHOTOS", "ACTIVE");
    await sweepDataDeletion(tdeps());
    const item = await photoItem(ghost.id);
    expect(item.state).toBe("DONE");
    expect(item.ghost).toBe(true);
  });

  it("with no proof candidate it stays FAILED (ghost_unproven), never DONE", async () => {
    const ghost = await claimedPhotoGhost();
    await setMode("PHOTOS", "ACTIVE");
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(/ghost_unproven/);
    const item = await photoItem(ghost.id);
    expect(item.state).toBe("FAILED");
    expect(item.lastError).toBe("ghost_unproven");
  });

  it("an admin retry of that FAILED item is judged again: still FAILED without a candidate, DONE once one exists", async () => {
    const { retryItems } =
      await import("../../src/services/dataDeletion.service.js");
    const ghost = await claimedPhotoGhost();
    await setMode("PHOTOS", "ACTIVE");
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(/ghost_unproven/);
    await retryItems({ itemId: (await photoItem(ghost.id)).id });
    await expect(sweepDataDeletion(tdeps())).rejects.toThrow(/ghost_unproven/);
    expect((await photoItem(ghost.id)).state).toBe("FAILED");
    await mk({ photo: true, evidence: true });
    await retryItems({ itemId: (await photoItem(ghost.id)).id });
    await sweepDataDeletion(tdeps());
    expect((await photoItem(ghost.id)).state).toBe("DONE");
  });

  it("a resumed item whose files exist is deleted as before (not a ghost)", async () => {
    const s = await mk({
      photo: true,
      order: { status: "DELIVERED", deliveredAt: ago(10 * DAY) },
    });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)} WHERE "id" = ${s.id}`;
    await prisma.deletionItem.create({
      data: {
        subjectType: "SESSION",
        subjectId: s.id,
        scope: "PHOTO",
        state: "CLAIMED",
        attempts: 1,
        preCount: { private: 1 },
        claimedAt: ago(HOUR),
      },
    });
    await setMode("PHOTOS", "ACTIVE");
    await sweepDataDeletion(tdeps());
    const item = await photoItem(s.id);
    expect(item.state).toBe("DONE");
    expect(item.ghost).toBe(false);
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
  });

  describe("the PDF branch", () => {
    async function claimedPdfGhost() {
      const ghost = await mk({
        order: {
          status: "DELIVERED",
          deliveredAt: ago(50 * DAY),
          pdf: "ghost",
        },
      });
      await prisma.$executeRaw`UPDATE "orders" SET "pdfDeletedAt" = ${ago(HOUR)} WHERE "id" = ${ghost.orderId}`;
      await prisma.deletionItem.create({
        data: {
          subjectType: "ORDER",
          subjectId: ghost.orderId!,
          scope: "PDF",
          state: "CLAIMED",
          attempts: 1,
          preCount: { public: 0 },
          claimedAt: ago(HOUR),
        },
      });
      return ghost;
    }
    const pdfItem = (orderId: string) =>
      prisma.deletionItem.findUniqueOrThrow({
        where: { subjectId_scope: { subjectId: orderId, scope: "PDF" } },
      });

    it("a resumed PDF whose file is absent and with no proof candidate is FAILED, not DONE", async () => {
      const ghost = await claimedPdfGhost();
      await setMode("BOOKS", "ACTIVE");
      await expect(sweepDataDeletion(tdeps())).rejects.toThrow(
        /ghost_unproven|proof_failed:pdfs/
      );
      expect((await pdfItem(ghost.orderId!)).state).not.toBe("DONE");
    });

    it("with a proof candidate (another order's PDF exists) it is DONE and flagged", async () => {
      await mk({
        order: {
          status: "GENERATED",
          pdf: "file",
          updatedAt: ago(100 * DAY),
        },
      });
      const ghost = await claimedPdfGhost();
      await setMode("BOOKS", "ACTIVE");
      await sweepDataDeletion(tdeps());
      const item = await pdfItem(ghost.orderId!);
      expect(item.state).toBe("DONE");
      expect(item.ghost).toBe(true);
    });
  });
});

describe("the payment guard never calls an ineligible preview clear", () => {
  it("an order with a payment id is not eligible: no clear verdict is stored and nothing is marked", async () => {
    const s = await mk({
      expiresAt: ago(10 * DAY),
      photo: true,
      order: {
        status: "CREATED",
        razorpayPaymentId: "pay_review2",
        updatedAt: ago(10 * DAY),
      },
    });
    const candidate = {
      group: "PREVIEWS" as const,
      scope: "SESSION" as const,
      subjectType: "SESSION" as const,
      subjectId: s.id,
      sessionId: s.id,
      orderId: s.orderId,
      dueAt: ago(10 * DAY),
    };
    const ctx = createRunContext(deps(), NOW.getTime() + 30_000, 20);
    expect(await gatherPaymentVerdict(ctx, candidate)).toBe("payment_id");
    expect(
      await prisma.deletionBlock.count({ where: { subjectId: s.orderId! } })
    ).toBe(0);
    const outcome = await processCandidate(ctx, candidate);
    expect(outcome).toEqual({ kind: "skipped", reason: "payment_id" });
    expect((await state(s.id)).filesDeletedAt).toBeNull();
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(1);
  });
});

describe("the lease is renewed while a request works through many items", () => {
  it("undoing several ghosts renews the lease before each item, and renewLease refuses another owner", async () => {
    const made: string[] = [];
    for (let n = 0; n < 3; n++) {
      const s = await mk({ ghostPhoto: true, expiresAt: ago(10 * DAY) });
      made.push(s.id);
      await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${ago(HOUR)}, "filesDeletedAt" = ${ago(HOUR)} WHERE "id" = ${s.id}`;
      await prisma.deletionItem.create({
        data: {
          subjectType: "SESSION",
          subjectId: s.id,
          scope: "SESSION",
          state: "DONE",
          ghost: true,
          lastError: "ghost_evidenced",
          preCount: { private: 0, public: 0 },
          claimedAt: new Date(),
        },
      });
    }
    // A clock that moves 10 minutes on every call: the lease end the database holds while each item is being
    // counted in storage must keep moving forward, which only a renewal before each item does.
    let calls = 0;
    const stepping: DeletionDeps = {
      ...deps(),
      now: () => new Date(NOW.getTime() + ++calls * 10 * 60_000),
    };
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const seen: number[] = [];
    let result!: Awaited<ReturnType<typeof undoGhosts>>;
    await withStorage(
      async (cmd, original, opts) => {
        if (cmd instanceof ListObjectsV2Command) {
          const row = await prisma.deletionSetting.findUniqueOrThrow({
            where: { id: 1 },
          });
          seen.push(row.leaseUntil?.getTime() ?? 0);
        }
        return original(cmd, opts);
      },
      async () => {
        result = await undoGhosts(
          {
            from: new Date(Date.now() - DAY).toISOString(),
            to: new Date(Date.now() + DAY).toISOString(),
          },
          stepping
        );
      }
    );
    expect(result.undone).toBeGreaterThanOrEqual(3);
    expect(result.ids).toHaveLength(result.undone);
    expect(seen.length).toBeGreaterThanOrEqual(result.undone);
    // Two lists per item (a session has two buckets): the end never goes back, and it moves on for every item.
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(result.undone);
    const owner = await acquireLease(tdeps());
    expect(await renewLease("someone-else", tdeps())).toBe(false);
    const clock = deps();
    expect(await renewLease(owner!, clock)).toBe(true);
    const row = await prisma.deletionSetting.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(row.leaseUntil?.getTime()).toBe(NOW.getTime() + LEASE_STALE_MS);
    await releaseLease(owner!);
  });
});

describe("a pause for unreachable storage ends only when every bucket of the group answers", () => {
  const refusePrivateHead = async (
    cmd: unknown,
    original: (c: unknown, o: unknown) => Promise<unknown>,
    opts: unknown
  ) => {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    if (
      cmd instanceof HeadObjectCommand &&
      (cmd.input as { Bucket?: string }).Bucket === config.r2.privateBucket
    )
      throw Object.assign(new Error("denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    return original(cmd, opts);
  };

  it("PHOTOS stays paused while its private bucket refuses the token, and resumes once it answers", async () => {
    await setMode("PHOTOS", "ACTIVE", { pausedReason: "storage_unreachable" });
    const s = await mk({
      photo: true,
      order: { status: "DELIVERED", deliveredAt: ago(10 * DAY) },
    });
    const logs = vi.spyOn(logger, "error");
    await withStorage(refusePrivateHead, async () => {
      await sweepDataDeletion(tdeps());
    });
    expect(
      (
        await prisma.deletionGroupSetting.findUniqueOrThrow({
          where: { group: "PHOTOS" },
        })
      ).pausedReason
    ).toBe("storage_unreachable");
    expect((await state(s.id)).photoDeletedAt).toBeNull();
    expect(errorLines(logs, /storage is not reachable/).length).toBe(1);
    await sweepDataDeletion(tdeps());
    expect(
      (
        await prisma.deletionGroupSetting.findUniqueOrThrow({
          where: { group: "PHOTOS" },
        })
      ).pausedReason
    ).toBeNull();
    expect((await state(s.id)).photoDeletedAt).not.toBeNull();
  });

  it("BOOKS only uses the public bucket, so a refused private bucket does not hold it", async () => {
    await setMode("BOOKS", "ACTIVE", { pausedReason: "storage_unreachable" });
    await withStorage(refusePrivateHead, async () => {
      await sweepDataDeletion(tdeps());
    });
    expect(
      (
        await prisma.deletionGroupSetting.findUniqueOrThrow({
          where: { group: "BOOKS" },
        })
      ).pausedReason
    ).toBeNull();
  });
});

describe("the delete loop checks the deadline before every batch of 10", () => {
  it("stops mid-page when the time is used up, leaves the item CLAIMED and gives the attempt back", async () => {
    const s = await mk({ expiresAt: ago(2 * HOUR), photo: true, extra: 25 });
    let clock = NOW.getTime();
    const jumping: DeletionDeps = {
      ...deps(),
      now: () => new Date(++clock),
    };
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    let jumped = false;
    await withStorage(
      async (cmd, original, opts) => {
        if (cmd instanceof DeleteObjectCommand && !jumped) {
          jumped = true;
          clock += 120_000;
        }
        return original(cmd, opts);
      },
      async () => {
        await sweepDataDeletion(jumping);
      }
    );
    const left = await countPrefix("private", `sessions/${s.id}/`);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(26);
    const item = await prisma.deletionItem.findUniqueOrThrow({
      where: { subjectId_scope: { subjectId: s.id, scope: "SESSION" } },
    });
    expect(item.state).toBe("CLAIMED");
    expect(item.attempts).toBe(0);
    // The next run finishes it.
    await sweepDataDeletion(tdeps());
    expect(await countPrefix("private", `sessions/${s.id}/`)).toBe(0);
  }, 60_000);
});

describe("the report lists what the owner reads before the first ACTIVE switch", () => {
  it("lists paid-never-delivered orders, open address rows after the AWB, stuck syncs and out-of-prefix sessions", async () => {
    const paid = await mk({
      order: { status: "GENERATED", updatedAt: ago(100 * DAY) },
    });
    const young = await mk({
      order: { status: "GENERATED", updatedAt: ago(DAY) },
    });
    await prisma.$executeRaw`UPDATE "orders" SET "createdAt" = ${ago(DAY)} WHERE "id" = ${young.orderId}`;
    const open = await mk({
      order: {
        status: "DELIVERED",
        deliveredAt: ago(50 * DAY),
        awbNumber: `AWB${RUN}1`,
      },
    });
    const settled = await mk({
      order: {
        status: "DELIVERED",
        deliveredAt: ago(50 * DAY),
        awbNumber: `AWB${RUN}2`,
      },
    });
    const noAwb = await mk({
      order: { status: "DELIVERED", deliveredAt: ago(50 * DAY) },
    });
    const stuck = await mk({
      order: { status: "DELIVERED", deliveredAt: ago(50 * DAY) },
    });
    const fresh = await mk({
      order: { status: "DELIVERED", deliveredAt: ago(50 * DAY) },
    });
    const change = (
      orderId: string,
      syncStatus: "FAILED" | "SYNCED" | "SYNCING",
      syncStartedAt?: Date
    ) =>
      prisma.orderAddressChange.create({
        data: {
          orderId,
          before: { name: "A" },
          after: { name: "B" },
          changedById: "admin-x",
          changedByEmail: "admin@example.test",
          syncStatus,
          syncStartedAt: syncStartedAt ?? null,
        },
      });
    await change(open.orderId!, "FAILED");
    await change(settled.orderId!, "SYNCED");
    await change(noAwb.orderId!, "FAILED");
    await change(stuck.orderId!, "SYNCING", ago(HOUR));
    await change(fresh.orderId!, "SYNCING", ago(1000));
    const blocked = await mk({ ghostPhoto: true });
    await prisma.deletionBlock.create({
      data: { subjectId: blocked.id, reason: "out_of_prefix", checkedAt: NOW },
    });
    const lists = await selectReportLists(NOW);
    expect(lists.paidNotDelivered).toContain(paid.orderId);
    expect(lists.paidNotDelivered).not.toContain(young.orderId);
    expect(lists.openAddress).toContain(open.orderId);
    expect(lists.openAddress).not.toContain(settled.orderId);
    expect(lists.openAddress).not.toContain(noAwb.orderId);
    expect(lists.stuckSync).toContain(stuck.orderId);
    expect(lists.stuckSync).not.toContain(fresh.orderId);
    expect(lists.outOfPrefix).toContain(blocked.id);
  });

  it("a BOOKS report stores them in its lists", async () => {
    const paid = await mk({
      order: { status: "GENERATED", updatedAt: ago(100 * DAY) },
    });
    await setMode("PHOTOS", "OFF");
    await setMode("BOOKS", "REPORT_ONLY");
    await sweepDataDeletion(tdeps());
    const report = await prisma.deletionRun.findFirstOrThrow({
      where: { group: "BOOKS", mode: "REPORT_ONLY" },
      orderBy: { startedAt: "desc" },
    });
    const lists = report.lists as Record<string, string[]>;
    for (const key of [
      "paidNotDelivered",
      "openAddress",
      "stuckSync",
      "outOfPrefix",
    ])
      expect(Array.isArray(lists[key]), key).toBe(true);
    expect(lists["paidNotDelivered"]).toContain(paid.orderId);
  });
});

describe("a report that keeps failing fails the sweep once, not on every tick", () => {
  // Makes the creation of a report fail (the delegate is swapped and put back by hand: restoring a spy on a Prisma
  // delegate removes the method).
  function failReports() {
    const holder = prisma as unknown as {
      deletionRun: Record<string, unknown>;
    };
    const original = holder.deletionRun;
    Object.defineProperty(holder, "deletionRun", {
      value: new Proxy(original, {
        get: (target, prop) =>
          prop === "create"
            ? () => Promise.reject(new Error("boom"))
            : target[prop as string],
      }),
      configurable: true,
      writable: true,
    });
    return () =>
      Object.defineProperty(holder, "deletionRun", {
        value: original,
        configurable: true,
        writable: true,
      });
  }
  const at = (days: number): DeletionDeps => ({
    ...deps(),
    now: () => new Date(NOW.getTime() + days * DAY),
  });

  it("throws when a report starts failing, stays quiet while it keeps failing, and throws again after a success", async () => {
    await setMode("PREVIEWS", "REPORT_ONLY");
    const errorLog = vi.spyOn(logger, "error");
    let restore = failReports();
    try {
      await expect(sweepDataDeletion(at(0))).rejects.toThrow(
        /PREVIEWS report failed/
      );
      // The fault lasts: the next ticks complete without failing the sweep, and the error is logged every time.
      await expect(sweepDataDeletion(at(0.01))).resolves.toBeTypeOf("number");
      await expect(sweepDataDeletion(at(0.02))).resolves.toBeTypeOf("number");
      expect(
        errorLog.mock.calls.filter((c) =>
          String(c[1]).includes("the report failed")
        ).length
      ).toBe(3);
    } finally {
      restore();
    }
    // The fault ends: a report is written and the sweep is quiet.
    await expect(sweepDataDeletion(at(0.03))).resolves.toBeTypeOf("number");
    expect(
      await prisma.deletionRun.count({ where: { group: "PREVIEWS" } })
    ).toBeGreaterThan(0);
    // A new fault, after a success, fails the sweep again (once the report is due again).
    restore = failReports();
    try {
      await prisma.deletionGroupSetting.update({
        where: { group: "PREVIEWS" },
        data: { lastReportAt: null },
      });
      await expect(sweepDataDeletion(at(0.04))).rejects.toThrow(
        /PREVIEWS report failed/
      );
      await expect(sweepDataDeletion(at(0.05))).resolves.toBeTypeOf("number");
    } finally {
      restore();
    }
  });
});
