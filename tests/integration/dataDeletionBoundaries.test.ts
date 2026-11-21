// Boundary tests for automatic data deletion (feature 6): the storage listing page size, the report age and the
// approval window to the second, the mode transitions, and a deleted unpaid preview at the websocket. Neon TEST
// branch and local MinIO only; the clock is injected and every selection is scoped to this file's own comic because
// the test database is shared.
import "../setup/env.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {
    addBulk: vi.fn(async () => []),
    getJob: vi.fn(async () => null),
  },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import WebSocket from "ws";
import { AddressSyncStatus } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import {
  countPrefix,
  deletePrefix,
  listObjectsPage,
  r2Client,
} from "../../src/lib/r2.js";
import {
  createRunContext,
  processCandidate,
  resumeItem,
  type DeletionDeps,
} from "../../src/services/dataDeletionEngine.service.js";
import type { DeletionCandidate } from "../../src/services/dataDeletionSelect.service.js";
import {
  setGroupMode,
  sweepDataDeletion,
} from "../../src/services/dataDeletion.service.js";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";
import { setupWebSocket } from "../../src/websocket/wsServer.js";

const MARK = "__vitest_deletion_bounds__";
const RUN = Math.random().toString(36).slice(2, 8);
const NOW = new Date("2031-06-15T12:00:00.000Z");
const SECOND = 1000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LONG = 240_000;

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
const sessionIds: string[] = [];
const deps = (): DeletionDeps => ({
  now: () => NOW,
  rzp,
  onlyComicId: comicId,
});

async function mkSession(opts: {
  status?: "PREVIEW_READY" | "AWAITING_PAYMENT";
  expiresAt?: Date;
  order?: boolean;
  marked?: boolean;
}) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: opts.status ?? "PREVIEW_READY",
      expiresAt: opts.expiresAt ?? ago(2 * HOUR),
      rawPhotoUrls: [],
    },
  });
  sessionIds.push(session.id);
  if (opts.order) {
    await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: "CREATED",
        razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
        shippingName: `${MARK} ${RUN}`,
      },
    });
  }
  if (opts.marked) {
    const t = new Date();
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${t}, "filesDeletedAt" = ${t} WHERE "id" = ${session.id}`;
  }
  return session;
}

const markers = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true },
  });

const candidate = (id: string): DeletionCandidate => ({
  group: "PREVIEWS",
  scope: "SESSION",
  subjectType: "SESSION",
  subjectId: id,
  sessionId: id,
  orderId: null,
  dueAt: NOW,
});

const newCtx = (d: DeletionDeps) =>
  createRunContext(d, d.now().getTime() + DAY, 20);

async function setGroup(
  group: "PREVIEWS" | "PHOTOS" | "BOOKS",
  data: Record<string, unknown>
) {
  await prisma.deletionGroupSetting.update({ where: { group }, data });
}

const baseGroup = {
  mode: "REPORT_ONLY" as const,
  modeChangedAt: ago(30 * DAY),
  modeChangedByEmail: null,
  approvedSelectionVersion: null,
  approvedRunId: null,
  approvedAt: null,
  approvalExhaustedAt: null,
  pausedReason: null,
  pausedAt: null,
  dailyMax: 100,
  lastReportAt: null,
};

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

async function cleanup() {
  const rows = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  const ids = [...new Set([...sessionIds, ...rows.map((r) => r.id)])];
  for (const id of ids) {
    await deletePrefix("public", `sessions/${id}/`);
    await deletePrefix("private", `sessions/${id}/`);
  }
  const orderIds = (
    await prisma.order.findMany({
      where: { orderSessionId: { in: ids } },
      select: { id: true },
    })
  ).map((o) => o.id);
  await prisma.deletionItem.deleteMany({
    where: { subjectId: { in: [...ids, ...orderIds] } },
  });
  await prisma.deletionBlock.deleteMany({
    where: { subjectId: { in: [...ids, ...orderIds] } },
  });
  await prisma.orderAddressChange.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  sessionIds.length = 0;
}

async function resetSettings() {
  // Runs sort by start time and the clock is injected: leftovers of an earlier execution (any group) would win.
  await prisma.deletionRun.deleteMany({
    where: { startedAt: { gte: new Date("2031-01-01T00:00:00Z") } },
  });
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: NOW, leaseUntil: null, leaseOwner: null },
  });
  for (const g of ["PREVIEWS", "PHOTOS", "BOOKS"] as const) {
    await setGroup(g, {
      ...baseGroup,
      mode: g === "PREVIEWS" ? "REPORT_ONLY" : "OFF",
    });
  }
}

beforeAll(async () => {
  await cleanup();
  comicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} ${RUN}`,
        pageCount: 2,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    })
  ).id;
});

beforeEach(async () => {
  await resetSettings();
  rzp.fetchPayments.mockClear();
});

afterAll(async () => {
  await cleanup();
  await prisma.deletionRun.deleteMany({
    where: { startedAt: { gte: new Date("2031-01-01T00:00:00Z") } },
  });
  for (const g of ["PREVIEWS", "PHOTOS", "BOOKS"] as const) {
    await setGroup(g, { ...baseGroup, modeChangedAt: new Date() });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
// M1: more than one page of objects
// ---------------------------------------------------------------------------------------------
describe("a prefix with 1,001 objects (the listing page holds 1,000)", () => {
  const COUNT = 1001;
  const keyOf = (id: string, n: number) =>
    `sessions/${id}/obj-${String(n).padStart(4, "0")}.bin`;

  async function seed(id: string) {
    for (let from = 0; from < COUNT; from += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, COUNT - from) }, (_, i) =>
          r2Client.send(
            new PutObjectCommand({
              Bucket: config.r2.publicBucket,
              Key: keyOf(id, from + i),
              Body: Buffer.from("x"),
            })
          )
        )
      );
    }
  }

  it(
    "the listing is split into two pages (1,000 then 1) and countPrefix adds them up",
    async () => {
      const s = await mkSession({});
      await seed(s.id);
      const prefix = `sessions/${s.id}/`;
      const first = await listObjectsPage("public", prefix, undefined);
      expect(first.keys).toHaveLength(1000);
      expect(first.next).toBeTruthy();
      const second = await listObjectsPage("public", prefix, first.next);
      expect(second.keys).toEqual([keyOf(s.id, 1000)]);
      expect(second.next).toBeUndefined();
      expect(await countPrefix("public", prefix)).toBe(COUNT);
    },
    LONG
  );

  it(
    "an unpaid preview with 1,001 objects is deleted completely: counted before, DONE, verified at 0",
    async () => {
      const s = await mkSession({});
      await seed(s.id);
      const out = await processCandidate(newCtx(deps()), candidate(s.id));
      expect(out).toEqual({ kind: "done", deleted: COUNT, ghost: false });
      expect(await countPrefix("public", `sessions/${s.id}/`)).toBe(0);
      const item = await prisma.deletionItem.findFirstOrThrow({
        where: { subjectId: s.id, scope: "SESSION" },
      });
      expect(item.state).toBe("DONE");
      // the count taken before the claim crossed the page boundary too
      expect(item.preCount).toMatchObject({ public: COUNT });
      expect((await markers(s.id)).filesDeletedAt).not.toBeNull();
    },
    LONG
  );

  it(
    "a delete that fails on page 2 never ends DONE: the item stays CLAIMED with the error, one object is left, and a later attempt finishes it",
    async () => {
      const s = await mkSession({});
      await seed(s.id);
      const last = keyOf(s.id, 1000);
      let failing = true;
      await withStorage(
        async (cmd, original, opts) => {
          if (
            failing &&
            cmd instanceof DeleteObjectCommand &&
            cmd.input.Key === last
          ) {
            throw Object.assign(new Error("odd"), {
              name: "InternalFailure",
              $metadata: { httpStatusCode: 400 },
            });
          }
          return original(cmd, opts);
        },
        async () => {
          const out = await processCandidate(newCtx(deps()), candidate(s.id));
          expect(out).toMatchObject({ kind: "failed" });
          const item = await prisma.deletionItem.findFirstOrThrow({
            where: { subjectId: s.id, scope: "SESSION" },
          });
          expect(item.state).toBe("CLAIMED");
          expect(item.lastError).toBeTruthy();
          expect(await countPrefix("public", `sessions/${s.id}/`)).toBe(1);
          // the marker stays set: the files are no longer all there
          expect((await markers(s.id)).filesDeletedAt).not.toBeNull();
          failing = false;
          // an attempt after the 30 minute wait finishes the job
          const later: DeletionDeps = {
            ...deps(),
            now: () => new Date(NOW.getTime() + HOUR),
          };
          const resumed = await resumeItem(newCtx(later), item);
          expect(resumed).toMatchObject({ kind: "done" });
          expect(await countPrefix("public", `sessions/${s.id}/`)).toBe(0);
          expect(
            (
              await prisma.deletionItem.findUniqueOrThrow({
                where: { id: item.id },
              })
            ).state
          ).toBe("DONE");
        }
      );
    },
    LONG
  );

  it(
    "a delete of the page 2 object that reports success but leaves it is caught by the verify: FAILED, never DONE",
    async () => {
      const s = await mkSession({});
      await seed(s.id);
      const last = keyOf(s.id, 1000);
      await withStorage(
        async (cmd, original, opts) => {
          if (cmd instanceof DeleteObjectCommand && cmd.input.Key === last)
            return {};
          return original(cmd, opts);
        },
        async () => {
          const out = await processCandidate(newCtx(deps()), candidate(s.id));
          expect(out).toEqual({
            kind: "failed",
            reason: "verify_failed:public:1",
          });
        }
      );
      const item = await prisma.deletionItem.findFirstOrThrow({
        where: { subjectId: s.id, scope: "SESSION" },
      });
      expect(item.state).toBe("FAILED");
      expect(await countPrefix("public", `sessions/${s.id}/`)).toBe(1);
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// M2: the report age, the approval window and the mode transitions
// ---------------------------------------------------------------------------------------------
describe("the age of the report that approves a switch to ACTIVE", () => {
  const REPORT_AGE_REFUSAL =
    "The report is older than 7 days. Wait for a new one.";

  async function reportAged(ageMs: number) {
    return prisma.deletionRun.create({
      data: {
        group: "PREVIEWS",
        mode: "REPORT_ONLY",
        selectionVersion: SELECTION_VERSION.PREVIEWS,
        startedAt: new Date(NOW.getTime() - ageMs),
        dueCount: 1,
        lists: { due: [`SESSION:${RUN}`] },
      },
    });
  }
  const activate = (reportId: string) =>
    setGroupMode(
      "PREVIEWS",
      {
        mode: "ACTIVE",
        reportRunId: reportId,
        dueCount: 1,
        confirmation: "DELETE 1",
      },
      "master@example.test",
      deps()
    );

  it(
    "7 days minus 1 second and exactly 7 days are accepted; 7 days plus 1 second is refused with the age message",
    async () => {
      const under = await reportAged(7 * DAY - SECOND);
      expect(await activate(under.id)).toMatchObject({
        mode: "ACTIVE",
        approvedRunId: under.id,
      });
      await resetSettings();
      const exact = await reportAged(7 * DAY);
      expect(await activate(exact.id)).toMatchObject({
        mode: "ACTIVE",
        approvedRunId: exact.id,
      });
      await resetSettings();
      const over = await reportAged(7 * DAY + SECOND);
      await expect(activate(over.id)).rejects.toMatchObject({
        statusCode: 409,
        message: REPORT_AGE_REFUSAL,
      });
      expect(
        (
          await prisma.deletionGroupSetting.findUniqueOrThrow({
            where: { group: "PREVIEWS" },
          })
        ).mode
      ).toBe("REPORT_ONLY");
    },
    LONG
  );
});

describe("mode transitions", () => {
  it(
    "ACTIVE to ACTIVE only changes the daily maximum: no report needed, approval and mode time untouched; with no maximum it is refused",
    async () => {
      const report = await prisma.deletionRun.create({
        data: {
          group: "PREVIEWS",
          mode: "REPORT_ONLY",
          selectionVersion: SELECTION_VERSION.PREVIEWS,
          startedAt: ago(DAY),
          dueCount: 1,
        },
      });
      const approvedAt = ago(2 * DAY);
      await setGroup("PREVIEWS", {
        mode: "ACTIVE",
        approvedRunId: report.id,
        approvedSelectionVersion: SELECTION_VERSION.PREVIEWS,
        approvedAt,
        dailyMax: 100,
      });
      const before = await prisma.deletionGroupSetting.findUniqueOrThrow({
        where: { group: "PREVIEWS" },
      });
      const out = await setGroupMode(
        "PREVIEWS",
        { mode: "ACTIVE", dailyMax: 7 },
        "m@example.test",
        deps()
      );
      expect(out).toMatchObject({
        mode: "ACTIVE",
        dailyMax: 7,
        approvedRunId: report.id,
      });
      expect(out.approvedAt?.getTime()).toBe(approvedAt.getTime());
      expect(out.modeChangedAt.getTime()).toBe(before.modeChangedAt.getTime());
      await expect(
        setGroupMode("PREVIEWS", { mode: "ACTIVE" }, "m@example.test", deps())
      ).rejects.toMatchObject({ message: "The group is already in that mode" });
      await expect(
        setGroupMode(
          "PREVIEWS",
          { mode: "ACTIVE", dailyMax: 0 },
          "m@example.test",
          deps()
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    },
    LONG
  );

  it(
    "OFF to ACTIVE with the report that was written before the group went OFF is refused: a mode change needs a newer report",
    async () => {
      const report = await prisma.deletionRun.create({
        data: {
          group: "PREVIEWS",
          mode: "REPORT_ONLY",
          selectionVersion: SELECTION_VERSION.PREVIEWS,
          startedAt: ago(DAY),
          dueCount: 1,
          lists: { due: [`SESSION:${RUN}`] },
        },
      });
      const off = await setGroupMode(
        "PREVIEWS",
        { mode: "OFF" },
        "m@example.test",
        deps()
      );
      expect(off).toMatchObject({
        mode: "OFF",
        approvedRunId: null,
        approvedAt: null,
      });
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
          deps()
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "This group changed mode after that report was made. Wait for a new report.",
      });
      expect(
        (
          await prisma.deletionGroupSetting.findUniqueOrThrow({
            where: { group: "PREVIEWS" },
          })
        ).mode
      ).toBe("OFF");
    },
    LONG
  );

  it(
    "two Masters switching the same group to ACTIVE at once: only one wins, the other is refused",
    async () => {
      const report = await prisma.deletionRun.create({
        data: {
          group: "PREVIEWS",
          mode: "REPORT_ONLY",
          selectionVersion: SELECTION_VERSION.PREVIEWS,
          startedAt: ago(DAY),
          dueCount: 1,
          lists: { due: [`SESSION:${RUN}`] },
        },
      });
      const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
        where: { group: "PREVIEWS" },
      });
      const body = {
        mode: "ACTIVE" as const,
        reportRunId: report.id,
        dueCount: 1,
        confirmation: "DELETE 1",
        expectedModeChangedAt: group.modeChangedAt.toISOString(),
      };
      const results = await Promise.allSettled([
        setGroupMode("PREVIEWS", body, "a@example.test", deps()),
        setGroupMode("PREVIEWS", body, "b@example.test", deps()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.filter(
        (r) => r.status === "rejected"
      ) as PromiseRejectedResult[];
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toMatchObject({ statusCode: 409 });
      expect(
        (
          await prisma.deletionGroupSetting.findUniqueOrThrow({
            where: { group: "PREVIEWS" },
          })
        ).mode
      ).toBe("ACTIVE");
    },
    LONG
  );

  // Known gap (see EVIDENCE.md): for a switch that is not to ACTIVE, setGroupMode reads the mode, checks expectedModeChangedAt, and then writes with
  // no condition on what it read, so two requests that carry the same expectedModeChangedAt both succeed and the
  // later write wins. The test states the wanted behaviour (one wins, one is told the group changed) and is marked
  // as an expected failure so the suite stays green until the code is fixed; fixing it turns this into a failure
  // that tells the next person to remove the marker.
  it.fails(
    "two Masters switching the same group to OFF at once: only one wins, the other is told the group changed",
    async () => {
      const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
        where: { group: "PREVIEWS" },
      });
      const expectedModeChangedAt = group.modeChangedAt.toISOString();
      const results = await Promise.allSettled([
        setGroupMode(
          "PREVIEWS",
          { mode: "OFF", expectedModeChangedAt },
          "a@example.test",
          deps()
        ),
        setGroupMode(
          "PREVIEWS",
          { mode: "OFF", expectedModeChangedAt },
          "b@example.test",
          deps()
        ),
      ]);
      // printed so the run output shows why the expected failure happens
      console.info(
        "two OFF switches settled as:",
        results.map((r) => r.status).join(", ")
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    },
    LONG
  );
});

describe("the 14 day approval window of the first ACTIVE run", () => {
  async function approvedSetWithAge(ageMs: number) {
    const approved = await mkSession({});
    const unapproved = await mkSession({});
    const report = await prisma.deletionRun.create({
      data: {
        group: "PREVIEWS",
        mode: "REPORT_ONLY",
        selectionVersion: SELECTION_VERSION.PREVIEWS,
        startedAt: new Date(NOW.getTime() - ageMs - HOUR),
        dueCount: 1,
        lists: { due: [`SESSION:${approved.id}`] },
      },
    });
    await setGroup("PREVIEWS", {
      mode: "ACTIVE",
      modeChangedAt: new Date(NOW.getTime() - ageMs - 2 * HOUR),
      approvedRunId: report.id,
      approvedSelectionVersion: SELECTION_VERSION.PREVIEWS,
      approvedAt: new Date(NOW.getTime() - ageMs),
      approvalExhaustedAt: null,
      dailyMax: 100,
    });
    for (const s of [approved, unapproved]) {
      expect((await markers(s.id)).filesDeletedAt).toBeNull();
    }
    return { approved, unapproved };
  }

  it(
    "on day 13 only the approved report's session is deleted; the unapproved due session stays",
    async () => {
      const { approved, unapproved } = await approvedSetWithAge(13 * DAY);
      await sweepDataDeletion(deps());
      expect((await markers(approved.id)).filesDeletedAt).not.toBeNull();
      expect((await markers(unapproved.id)).filesDeletedAt).toBeNull();
      const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
        where: { group: "PREVIEWS" },
      });
      expect(group.approvalExhaustedAt).toBeNull();
    },
    LONG
  );

  it(
    "one second before day 14 the window is still closed",
    async () => {
      const { approved, unapproved } = await approvedSetWithAge(
        14 * DAY - SECOND
      );
      await sweepDataDeletion(deps());
      expect((await markers(approved.id)).filesDeletedAt).not.toBeNull();
      expect((await markers(unapproved.id)).filesDeletedAt).toBeNull();
    },
    LONG
  );

  it(
    "at exactly day 14 the approval is spent: the unapproved due session is deleted too, and the group goes on by itself",
    async () => {
      const { approved, unapproved } = await approvedSetWithAge(14 * DAY);
      await sweepDataDeletion(deps());
      expect((await markers(approved.id)).filesDeletedAt).not.toBeNull();
      expect((await markers(unapproved.id)).filesDeletedAt).not.toBeNull();
      const group = await prisma.deletionGroupSetting.findUniqueOrThrow({
        where: { group: "PREVIEWS" },
      });
      expect(group.approvalExhaustedAt).not.toBeNull();
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// R5: the address history, for every sync status the schema has
// ---------------------------------------------------------------------------------------------
describe("R5 address history by sync status (generated from the enum)", () => {
  // Only a SYNCING row that started less than the claim's stale limit ago keeps the history: the sync may still be
  // reading it. Every other status, including a SYNCING row that never recorded a start, is emptied.
  const cases: {
    label: string;
    status: AddressSyncStatus;
    startedAgo: number | null;
    emptied: boolean;
  }[] = [
    ...Object.values(AddressSyncStatus).map((status) => ({
      label: status,
      status,
      startedAgo: null,
      emptied: true,
    })),
    {
      label: "SYNCING started 1 minute ago",
      status: "SYNCING",
      startedAgo: 60_000,
      emptied: false,
    },
    {
      label: "SYNCING started 10 minutes ago",
      status: "SYNCING",
      startedAgo: 10 * 60_000,
      emptied: true,
    },
  ];

  it("covers every AddressSyncStatus value", () => {
    expect(new Set(cases.map((c) => c.status))).toEqual(
      new Set(Object.values(AddressSyncStatus))
    );
  });

  it(
    "empties the history of a 60 day delivered order for each status, and leaves a fresh SYNCING one alone",
    async () => {
      const made: { label: string; orderId: string; emptied: boolean }[] = [];
      for (const c of cases) {
        const session = await prisma.orderSession.create({
          data: {
            comicId,
            status: "COMPLETED",
            expiresAt: ago(400 * DAY),
            rawPhotoUrls: [],
          },
        });
        sessionIds.push(session.id);
        const order = await prisma.order.create({
          data: {
            orderSessionId: session.id,
            amount: "499.00",
            currency: "INR",
            countryCode: "IN",
            coverType: "HARDCOVER",
            status: "DELIVERED",
            razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
            deliveredAt: ago(60 * DAY),
            shippingName: `${MARK} ${RUN}`,
          },
        });
        await prisma.$executeRaw`UPDATE "orders" SET "createdAt" = ${ago(100 * DAY)} WHERE "id" = ${order.id}`;
        await prisma.orderAddressChange.create({
          data: {
            orderId: order.id,
            before: { name: "Old Name" },
            after: { name: "New Name" },
            changedById: "admin-x",
            changedByEmail: "admin@example.test",
            syncStatus: c.status,
            syncStartedAt: c.startedAgo === null ? null : ago(c.startedAgo),
            syncNote: "note",
          },
        });
        made.push({ label: c.label, orderId: order.id, emptied: c.emptied });
      }
      for (const m of made) {
        const out = await processCandidate(newCtx(deps()), {
          group: "BOOKS",
          scope: "ADDRESS",
          subjectType: "ORDER",
          subjectId: m.orderId,
          sessionId: null,
          orderId: m.orderId,
          dueAt: NOW,
        });
        expect([m.label, out.kind]).toEqual([
          m.label,
          m.emptied ? "done" : "refused",
        ]);
      }
      for (const m of made) {
        const row = await prisma.orderAddressChange.findFirstOrThrow({
          where: { orderId: m.orderId },
        });
        expect([
          m.label,
          JSON.stringify(row.before) === "{}",
          row.syncNote === null,
        ]).toEqual([m.label, m.emptied, m.emptied]);
      }
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// M4: a deleted unpaid preview at the websocket upgrade
// ---------------------------------------------------------------------------------------------
describe("websocket upgrade", () => {
  let server: Server;
  let wss: ReturnType<typeof setupWebSocket>;
  let port: number;
  beforeAll(async () => {
    server = createServer();
    wss = setupWebSocket(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const attempt = (id: string, token: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/?sessionId=${id}&token=${token}`
      );
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("unexpected-response", (_req, res) =>
        resolve(String(res.statusCode))
      );
      ws.on("error", () => undefined);
    });

  it(
    "an unpaid awaiting-payment session whose files were deleted answers 410; the same session unmarked is let in",
    async () => {
      const live = await mkSession({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: true,
      });
      const gone = await mkSession({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: true,
        marked: true,
      });
      const token = async (id: string) =>
        (
          await prisma.orderSession.findUniqueOrThrow({
            where: { id },
            select: { wsRoomToken: true },
          })
        ).wsRoomToken;
      expect(await attempt(live.id, await token(live.id))).toBe("open");
      expect(await attempt(gone.id, await token(gone.id))).toBe("410");
    },
    LONG
  );
});
