// Integration tests for the admin's "restart stuck pages" tool. They run against the Neon
// TEST branch only: the setup import below refuses any other database. Redis, the job queue,
// the websocket and the emails are replaced by fakes, so nothing reaches the outside.
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

const fake = vi.hoisted(() => {
  type Job = { state: string; removeFails?: boolean };
  const jobs = new Map<string, Job>();
  const redis = { status: "ready" };
  return {
    jobs,
    redis,
    onGetJob: undefined as undefined | ((id: string) => Promise<void>),
    addBulk: vi.fn(async (items: { opts: { jobId: string } }[]) => {
      items.forEach((i) => jobs.set(i.opts.jobId, { state: "waiting" }));
      return [];
    }),
    removed: [] as string[],
    settle: vi.fn(async () => ({ flipped: true })),
    emitPaidReady: vi.fn(),
    notifyBookReady: vi.fn(async () => ({})),
    notifyPaymentReceived: vi.fn(async () => ({})),
  };
});

vi.mock("../../src/lib/redis.js", () => ({ redisClient: fake.redis }));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {
    addBulk: fake.addBulk,
    getJob: vi.fn(async (id: string) => {
      if (fake.onGetJob) await fake.onGetJob(id);
      const job = fake.jobs.get(id);
      if (!job) return null;
      return {
        getState: async () => job.state,
        remove: async () => {
          if (job.removeFails) throw new Error("Job is locked");
          fake.removed.push(id);
          fake.jobs.delete(id);
        },
      };
    }),
  },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/jobs/workers/generationWorker.js", () => ({
  settleTerminalPageFailure: fake.settle,
}));
vi.mock("../../src/websocket/event.js", () => ({
  emitSessionPaidReady: fake.emitPaidReady,
}));
vi.mock("../../src/services/notification.service.js", () => ({
  notifyBookReady: fake.notifyBookReady,
  notifyPaymentReceived: fake.notifyPaymentReceived,
  notifySentToPrint: vi.fn(),
}));
vi.mock("../../src/config/pageRecovery.js", async (original) => ({
  ...(await original<typeof import("../../src/config/pageRecovery.js")>()),
  QUEUE_WAIT_MS: 150,
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  _resetOrderSlots,
  getOrderPageStatus,
  regenerateOrderPages,
} from "../../src/services/pageRecovery.service.js";
import { AppError } from "../../src/utils/errors.js";
import type {
  OrderSessionStatus,
  OrderStatus,
  PageVersionStatus,
} from "../../src/generated/prisma/client.js";

const MARK = "__vitest_pagerecovery__";
const RUN = Math.random().toString(36).slice(2, 8);
const ADMIN = "vitest-admin";

const comicIds: string[] = [];
const sessionIds: string[] = [];
const userIds: string[] = [];

type RowSpec = [
  variantIndex: number,
  status: PageVersionStatus,
  minutesAgo: number,
  error?: string,
];
type Staged = {
  orderId: string;
  sessionId: string;
  pages: Record<number, string>;
  rows: Record<string, string>; // "page:variant" -> row id
};

const minutes = (m: number) => new Date(Date.now() - m * 60 * 1000);

/** Pages 1 (free preview) and 2..5 (paid, 2 and 3 have a face). `rows` by page number. */
async function stage(opts: {
  label: string;
  order?: OrderStatus;
  session?: OrderSessionStatus;
  orderAgeMinutes?: number;
  pdfUrl?: string;
  rows: Record<number, RowSpec[]>;
}): Promise<Staged> {
  const userId = `${MARK}-${RUN}-${opts.label}`;
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  userIds.push(userId);
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} ${opts.label}`,
      pageCount: 5,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicIds.push(comic.id);
  const pages: Record<number, string> = {};
  for (const n of [1, 2, 3, 4, 5]) {
    const page = await prisma.page.create({
      data: {
        comicId: comic.id,
        pageNumber: n,
        isPreviewPage: n === 1,
        hasFace: n === 2 || n === 3,
      },
    });
    pages[n] = page.id;
  }
  const session = await prisma.orderSession.create({
    data: {
      comicId: comic.id,
      userId,
      status: opts.session ?? "GENERATING_PAID",
      coverType: "HARDCOVER",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  sessionIds.push(session.id);
  await prisma.sessionPage.createMany({
    data: [1, 2, 3, 4, 5].map((n) => ({
      orderSessionId: session.id,
      pageId: pages[n]!,
      isPreviewPage: n === 1,
    })),
  });
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: 999,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
      status: opts.order ?? "PAID",
      shippingName: `${MARK} ${RUN}`,
      pdfUrl: opts.pdfUrl ?? null,
    },
  });
  if (opts.orderAgeMinutes !== undefined) {
    await prisma.order.update({
      where: { id: order.id },
      data: { updatedAt: minutes(opts.orderAgeMinutes) },
    });
  }
  const rows: Record<string, string> = {};
  for (const [pageNumber, specs] of Object.entries(opts.rows)) {
    for (const [variantIndex, status, minutesAgo, error] of specs) {
      const row = await prisma.pageVersion.create({
        data: {
          orderSessionId: session.id,
          pageId: pages[Number(pageNumber)]!,
          variantIndex,
          status,
          errorMessage: error ?? null,
          textStampedUrl:
            status === "SD_READY"
              ? null
              : "https://r2.example.com/old-stamp.png",
        },
      });
      await prisma.pageVersion.update({
        where: { id: row.id },
        data: { updatedAt: minutes(minutesAgo) },
      });
      rows[`${pageNumber}:${variantIndex}`] = row.id;
    }
  }
  return { orderId: order.id, sessionId: session.id, pages, rows };
}

/** Finished rows for the given pages, so a test restarts only what it names. */
const finished = (...pages: number[]): Record<number, RowSpec[]> =>
  Object.fromEntries(pages.map((n) => [n, [[0, "SD_READY", 90] as RowSpec]]));

const readRow = (s: Staged, key: string) =>
  prisma.pageVersion.findUniqueOrThrow({ where: { id: s.rows[key]! } });
const sessionStatus = async (s: Staged) =>
  (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.sessionId } }))
    .status;
const orderRow = (s: Staged) =>
  prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  return null;
}

beforeEach(() => {
  fake.jobs.clear();
  fake.removed.length = 0;
  fake.addBulk.mockClear();
  fake.settle.mockClear();
  fake.emitPaidReady.mockClear();
  fake.notifyBookReady.mockClear();
  fake.notifyPaymentReceived.mockClear();
  fake.redis.status = "ready";
  fake.onGetJob = undefined;
  _resetOrderSlots();
});

beforeAll(async () => {
  await cleanup();
});

async function cleanup() {
  await prisma.order.deleteMany({
    where: { shippingName: { startsWith: MARK } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.comic.deleteMany({ where: { id: { in: comicIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------

describe("GET the pages of an order", () => {
  it("a healthy book is all READY and the queue is never asked", async () => {
    const s = await stage({
      label: "healthy",
      rows: {
        1: [[0, "SD_READY", 60]],
        2: [[0, "SD_READY", 60]],
        3: [[0, "SD_READY", 60]],
        4: [[0, "SD_READY", 60]],
        5: [[0, "SD_READY", 60]],
      },
    });
    const result = await getOrderPageStatus(s.orderId);
    expect(result.summary).toMatchObject({
      total: 5,
      ready: 5,
      stuck: 0,
      failed: 0,
    });
    expect(result.queueAvailable).toBe(true);
    expect(fake.jobs.size).toBe(0);
  });

  it("shows each page's state, which pages use the image service, and cleaned error text", async () => {
    fake.jobs.set("placeholder", { state: "active" });
    const s = await stage({
      label: "mixed",
      rows: {
        1: [[0, "SD_READY", 60]],
        2: [
          [
            0,
            "FAILED",
            20,
            "RunPod said no at https://api.runpod.ai/v2/x/status/1 " +
              "x".repeat(300),
          ],
        ],
        3: [[0, "QUEUED", 5]], // no job: stuck
        4: [[0, "GENERATING_SD", 1]], // alive (under 2 minutes)
        // page 5 has no row
      },
    });
    const result = await getOrderPageStatus(s.orderId);
    const byNumber = Object.fromEntries(
      result.pages.map((p) => [p.pageNumber, p])
    );
    expect(byNumber[1]).toMatchObject({ state: "READY", isPreviewPage: true });
    expect(byNumber[2]).toMatchObject({
      state: "FAILED",
      restartable: true,
      usesImageService: true,
    });
    expect(byNumber[2]!.lastError).not.toContain("https://");
    expect(byNumber[2]!.lastError!.length).toBeLessThanOrEqual(201);
    expect(byNumber[3]).toMatchObject({
      state: "STUCK",
      restartable: true,
      usesImageService: true,
    });
    expect(byNumber[4]).toMatchObject({
      state: "IN_PROGRESS",
      restartable: false,
      usesImageService: false,
    });
    expect(byNumber[5]).toMatchObject({
      state: "NOT_STARTED",
      restartable: true,
    });
    expect(result.summary).toMatchObject({
      total: 5,
      ready: 1,
      failed: 1,
      stuck: 1,
      inProgress: 1,
      notStarted: 1,
    });
  });

  it("is readable for an order that cannot be restarted, and says why", async () => {
    const s = await stage({
      label: "unpaid",
      order: "CREATED",
      session: "AWAITING_PAYMENT",
      rows: {},
    });
    const result = await getOrderPageStatus(s.orderId);
    expect(result.canRegenerate).toBe(false);
    expect(result.blockedReason).toMatch(/not been paid/);
    expect(
      result.pages.every((p) => !p.restartable || p.state === "NOT_STARTED")
    ).toBe(true);
    expect(result.pages.some((p) => p.restartable)).toBe(false);
  });

  it("offers no restart when Redis is not ready, and does not call it", async () => {
    fake.redis.status = "reconnecting";
    const s = await stage({
      label: "noredis",
      rows: { 2: [[0, "QUEUED", 500]], 3: [[0, "FAILED", 500]] },
    });
    const result = await getOrderPageStatus(s.orderId);
    expect(result.queueAvailable).toBe(false);
    expect(result.pages.some((p) => p.restartable)).toBe(false);
    expect(result.pages.find((p) => p.pageNumber === 2)!.state).toBe(
      "IN_PROGRESS"
    );
  });

  it("a page with a finished variant and a stuck retry is BLOCKED and restartable", async () => {
    const s = await stage({
      label: "blocked",
      rows: {
        2: [
          [0, "SD_READY", 90],
          [1, "QUEUED", 5],
        ],
      },
    });
    const result = await getOrderPageStatus(s.orderId);
    expect(result.pages.find((p) => p.pageNumber === 2)).toMatchObject({
      state: "BLOCKED",
      restartable: true,
    });
    expect(result.summary.blocked).toBe(1);
  });

  it("answers 404 for an unknown order", async () => {
    const err = await refusal(
      getOrderPageStatus("00000000-0000-4000-8000-00000000dead")
    );
    expect(err?.statusCode).toBe(404);
  });

  it("the signature changes when a row changes; a long poll with an unchanged signature waits, with a changed one answers at once", async () => {
    const s = await stage({ label: "sig", rows: { 2: [[0, "QUEUED", 1]] } });
    fake.jobs.set(s.rows["2:0"]!, { state: "waiting" });
    const first = await getOrderPageStatus(s.orderId);

    let started = Date.now();
    await getOrderPageStatus(s.orderId, { wait: 1, sig: "something-else" });
    expect(Date.now() - started).toBeLessThan(900); // answers at once

    started = Date.now();
    const waited = await getOrderPageStatus(s.orderId, {
      wait: 1,
      sig: first.signature,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // held about a second
    expect(waited.signature).toBe(first.signature);

    await prisma.pageVersion.update({
      where: { id: s.rows["2:0"]! },
      data: { status: "TEXT_STAMPING" },
    });
    const changed = await getOrderPageStatus(s.orderId);
    expect(changed.signature).not.toBe(first.signature);
  });

  it("a long poll ends when the client has gone", async () => {
    const s = await stage({ label: "closed", rows: { 2: [[0, "QUEUED", 1]] } });
    const first = await getOrderPageStatus(s.orderId);
    const started = Date.now();
    await getOrderPageStatus(s.orderId, {
      wait: 25,
      sig: first.signature,
      isClosed: () => true,
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: what is refused", () => {
  it("refuses an unpaid, printed or cancelled order with a plain sentence and changes nothing", async () => {
    const cases: [
      string,
      OrderStatus,
      OrderSessionStatus,
      string | undefined,
      RegExp,
    ][] = [
      ["r-created", "CREATED", "AWAITING_PAYMENT", undefined, /not been paid/],
      ["r-confirmed", "CONFIRMED", "CONFIRMED", undefined, /frozen/],
      ["r-cancelled", "CANCELLED", "FAILED", undefined, /cancelled/],
      ["r-pdf", "GENERATED", "PAID_PAGES_READY", "x.pdf", /frozen/],
    ];
    for (const [label, order, session, pdfUrl, text] of cases) {
      const s = await stage({
        label,
        order,
        session,
        pdfUrl,
        rows: { 2: [[0, "FAILED", 60]] },
      });
      const err = await refusal(
        regenerateOrderPages(s.orderId, ADMIN, { force: true })
      );
      expect(err?.statusCode, label).toBe(409);
      expect(err?.message, label).toMatch(text);
      expect((await readRow(s, "2:0")).status, label).toBe("FAILED");
    }
    expect(fake.addBulk).not.toHaveBeenCalled();
  });

  it("(PAID, PAID) younger than 10 minutes is still being processed", async () => {
    const s = await stage({
      label: "young",
      session: "PAID",
      orderAgeMinutes: 3,
      rows: {},
    });
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(409);
    expect(err?.message).toMatch(/still being processed/);
  });

  it("answers 503 and changes nothing when Redis is not ready, and does not hold the next try back", async () => {
    const s = await stage({
      label: "redisdown",
      rows: { ...finished(1, 3, 4, 5), 2: [[0, "FAILED", 60]] },
    });
    fake.redis.status = "reconnecting";
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(503);
    expect(err?.message).toMatch(/Nothing was changed/);
    expect((await readRow(s, "2:0")).status).toBe("FAILED");
    fake.redis.status = "ready";
    const again = await regenerateOrderPages(s.orderId, ADMIN, {});
    expect(again.queued).toHaveLength(1);
  });

  it("allows one restart per order per minute (429), and other orders are unaffected", async () => {
    const a = await stage({
      label: "limit-a",
      rows: {
        ...finished(1, 4, 5),
        2: [[0, "FAILED", 60]],
        3: [[0, "FAILED", 60]],
      },
    });
    const b = await stage({
      label: "limit-b",
      rows: { ...finished(1, 3, 4, 5), 2: [[0, "FAILED", 60]] },
    });
    await regenerateOrderPages(a.orderId, ADMIN, { pageNumbers: [2] });
    const err = await refusal(
      regenerateOrderPages(a.orderId, ADMIN, { pageNumbers: [3], force: true })
    );
    expect(err?.statusCode).toBe(429);
    expect(err?.code).toBe("TOO_MANY_REQUESTS");
    expect((await readRow(a, "3:0")).status).toBe("FAILED");
    expect(
      (await regenerateOrderPages(b.orderId, ADMIN, {})).queued
    ).toHaveLength(1);
  });

  it("a refused request (order rule) does not use up the minute", async () => {
    const s = await stage({
      label: "refused-then-ok",
      session: "PAID",
      orderAgeMinutes: 3,
      rows: {},
    });
    expect(
      (await refusal(regenerateOrderPages(s.orderId, ADMIN, {})))?.statusCode
    ).toBe(409);
    expect(
      (await refusal(regenerateOrderPages(s.orderId, ADMIN, {})))?.statusCode
    ).toBe(409); // not 429
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: restarting pages in place", () => {
  it("resets a failed row in place (no new variant), clears the stale stamp, queues one job, and never touches the order", async () => {
    const s = await stage({
      label: "inplace",
      rows: { 2: [[0, "FAILED", 30, "boom"]], 4: [[0, "SD_READY", 30]] },
    });
    const orderBefore = await orderRow(s);
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
    });

    expect(result.queued).toEqual([
      { pageNumber: 2, pageVersionId: s.rows["2:0"] },
    ]);
    const row = await readRow(s, "2:0");
    expect(row).toMatchObject({
      status: "QUEUED",
      textStampedUrl: null,
      errorMessage: "boom",
    });
    expect(
      await prisma.pageVersion.count({
        where: { orderSessionId: s.sessionId, pageId: s.pages[2]! },
      })
    ).toBe(1);
    expect(fake.addBulk).toHaveBeenCalledTimes(1);
    expect(fake.addBulk.mock.calls[0]![0]).toHaveLength(1);
    expect(fake.addBulk.mock.calls[0]![0][0]).toMatchObject({
      opts: { jobId: s.rows["2:0"], priority: 2 },
    });

    const orderAfter = await orderRow(s);
    expect(orderAfter.status).toBe(orderBefore.status);
    expect(orderAfter.updatedAt.getTime()).toBe(
      orderBefore.updatedAt.getTime()
    );
    expect(await sessionStatus(s)).toBe("GENERATING_PAID"); // plain mode: not touched
    expect((await readRow(s, "4:0")).status).toBe("SD_READY"); // finished page untouched
  });

  it("with no pages named it restarts every restartable page, and only those", async () => {
    const s = await stage({
      label: "all",
      rows: {
        1: [[0, "SD_READY", 60]],
        2: [[0, "FAILED", 30]],
        3: [[0, "QUEUED", 5]],
        4: [[0, "GENERATING_SD", 0]],
      },
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      force: true,
    });
    const numbers = result.queued.map((q) => q.pageNumber).sort();
    expect(numbers).toEqual([2, 3, 5]); // 5 has no row yet
    expect((await readRow(s, "4:0")).status).toBe("GENERATING_SD"); // alive: left alone
    expect(result.notTouched).toEqual({ finished: 1, running: 1 });
  });

  it("names a finished page or a running page: skipped, with a reason", async () => {
    const s = await stage({
      label: "skips",
      rows: { 2: [[0, "SD_READY", 60]], 3: [[0, "GENERATING_SD", 0]] },
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2, 3, 99],
    });
    expect(result.queued).toHaveLength(0);
    const reasons = Object.fromEntries(
      result.skipped.map((x) => [x.pageNumber, x.reason])
    );
    expect(reasons).toEqual({
      2: "FINISHED",
      3: "ALREADY_RUNNING",
      99: "NOT_IN_BOOK",
    });
    expect(fake.addBulk).not.toHaveBeenCalled();
  });

  it("restarts the newest unfinished row of a page, and leaves older failed rows as history", async () => {
    const s = await stage({
      label: "history",
      rows: {
        2: [
          [0, "FAILED", 60],
          [1, "FAILED", 40],
        ],
      },
    });
    await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
      force: true,
    });
    expect((await readRow(s, "2:1")).status).toBe("QUEUED");
    expect((await readRow(s, "2:0")).status).toBe("FAILED");
  });

  it("restarts only the stuck retry of a page that already has a finished variant", async () => {
    const s = await stage({
      label: "blocked-restart",
      rows: {
        2: [
          [0, "SD_READY", 90],
          [1, "QUEUED", 5],
        ],
      },
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
    });
    expect(result.queued).toEqual([
      { pageNumber: 2, pageVersionId: s.rows["2:1"] },
    ]);
    expect((await readRow(s, "2:0")).status).toBe("SD_READY");
  });

  it("holds a row that may still be running at the image service back for 10 minutes unless forced", async () => {
    const s = await stage({
      label: "cooldown",
      rows: {
        ...finished(1, 5),
        2: [[0, "FAILED", 3]],
        3: [[0, "GENERATING_SD", 3]],
        4: [[0, "QUEUED", 3]],
      },
    });
    const held = await regenerateOrderPages(s.orderId, ADMIN, {});
    expect(held.queued.map((q) => q.pageNumber)).toEqual([4]); // never reached the image service
    expect(held.skipped.map((x) => [x.pageNumber, x.reason]).sort()).toEqual([
      [2, "COOLING_DOWN"],
      [3, "COOLING_DOWN"],
    ]);
    expect(held.skipped[0]!.cooldownEndsAt).toBeTruthy();

    _resetOrderSlots();
    const forced = await regenerateOrderPages(s.orderId, ADMIN, {
      force: true,
    });
    expect(forced.queued.map((q) => q.pageNumber).sort()).toEqual([2, 3]); // page 4 was just restarted and waits in the queue
  });

  it("creates variant 0 for a paid page that has no row, but never for a free preview page", async () => {
    const s = await stage({
      label: "notstarted",
      rows: { 2: [[0, "SD_READY", 60]] },
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {});
    expect(result.queued.map((q) => q.pageNumber).sort()).toEqual([3, 4, 5]);
    const rows = await prisma.pageVersion.findMany({
      where: { orderSessionId: s.sessionId },
    });
    expect(rows.filter((r) => r.pageId === s.pages[1]!)).toHaveLength(0); // preview page: no row
    for (const n of [3, 4, 5]) {
      const row = rows.find((r) => r.pageId === s.pages[n]!)!;
      expect(row).toMatchObject({ variantIndex: 0, status: "QUEUED" });
    }
  });

  it("a page changed after it was classified is reported CHANGED and left alone (plain session)", async () => {
    const s = await stage({
      label: "changed",
      rows: { 2: [[0, "QUEUED", 5]], 3: [[0, "FAILED", 60]] },
    });
    // a worker writes to page 2's row just after the queue is asked about it
    fake.onGetJob = async (id) => {
      if (id === s.rows["2:0"]) {
        await prisma.pageVersion.update({
          where: { id },
          data: { status: "TEXT_STAMPING" },
        });
      }
    };
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      force: true,
    });
    expect(result.skipped).toEqual([
      expect.objectContaining({ pageNumber: 2, reason: "CHANGED" }),
    ]);
    expect(result.queued.map((q) => q.pageNumber).sort()).toEqual([3, 4, 5]);
    expect((await readRow(s, "2:0")).status).toBe("TEXT_STAMPING");
  });

  it("removes a finished job record so the new add goes through, and a waiting job that has waited 10 minutes", async () => {
    const s = await stage({
      label: "jobs",
      rows: { 2: [[0, "QUEUED", 11]], 3: [[0, "QUEUED", 5]] },
    });
    fake.jobs.set(s.rows["2:0"]!, { state: "waiting" }); // waiting 11 minutes: stuck
    fake.jobs.set(s.rows["3:0"]!, { state: "failed" }); // job failed, row never settled
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2, 3],
      force: true,
    });
    expect(result.queued.map((q) => q.pageNumber).sort()).toEqual([2, 3]);
    expect(fake.removed.sort()).toEqual([s.rows["2:0"], s.rows["3:0"]].sort());
  });

  it("a job that cannot be removed (a worker holds it) is left to finish: ALREADY_RUNNING", async () => {
    const s = await stage({
      label: "locked",
      rows: { 2: [[0, "QUEUED", 11]] },
    });
    fake.jobs.set(s.rows["2:0"]!, { state: "waiting", removeFails: true });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
    });
    expect(result.queued).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ pageNumber: 2, reason: "ALREADY_RUNNING" }),
    ]);
    expect(fake.addBulk).not.toHaveBeenCalled();
  });

  it("a page whose job is active and untouched for 30 minutes needs Restart anyway", async () => {
    const s = await stage({
      label: "ghost",
      rows: { 2: [[0, "GENERATING_SD", 35]] },
    });
    fake.jobs.set(s.rows["2:0"]!, { state: "active" });
    const held = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
    });
    expect(held.queued).toHaveLength(0);
    expect(held.skipped[0]).toMatchObject({ reason: "ALREADY_RUNNING" });
    _resetOrderSlots();
    const forced = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
      force: true,
    });
    expect(forced.queued).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: a session that failed after payment", () => {
  it("restores GENERATING_PAID and restarts ALL restartable pages, even when one is named", async () => {
    const s = await stage({
      label: "restore",
      session: "FAILED",
      rows: {
        1: [[0, "SD_READY", 90]],
        2: [[0, "FAILED", 60]],
        3: [[0, "FAILED", 60]],
        4: [[0, "FAILED", 60]],
        5: [[0, "FAILED", 60]],
      },
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {
      pageNumbers: [2],
    });
    expect(result.expanded).toBe(true);
    expect(result.sessionRestored).toBe(true);
    expect(result.queued.map((q) => q.pageNumber).sort()).toEqual([2, 3, 4, 5]);
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
    expect((await orderRow(s)).status).toBe("PAID");
  });

  it("also repairs a paid session that was sent back to the preview stage by mistake", async () => {
    for (const session of ["PREVIEW_READY", "GENERATING_PREVIEW"] as const) {
      const s = await stage({
        label: `restore-${session}`,
        session,
        rows: { 1: [[0, "SD_READY", 90]], 2: [[0, "FAILED", 60]] },
      });
      const result = await regenerateOrderPages(s.orderId, ADMIN, {});
      expect(result.sessionRestored, session).toBe(true);
      expect(await sessionStatus(s), session).toBe("GENERATING_PAID");
    }
  });

  it("is all or nothing for the cooldown: one page in cooldown stops the whole restart", async () => {
    const s = await stage({
      label: "restore-cool",
      session: "FAILED",
      rows: { 2: [[0, "FAILED", 60]], 3: [[0, "FAILED", 3]] },
    });
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(409);
    expect(err?.message).toMatch(/Nothing was changed/);
    expect((await readRow(s, "2:0")).status).toBe("FAILED");
    expect(await sessionStatus(s)).toBe("FAILED");
    expect(fake.addBulk).not.toHaveBeenCalled();

    _resetOrderSlots();
    const forced = await regenerateOrderPages(s.orderId, ADMIN, {
      force: true,
    });
    expect(forced.sessionRestored).toBe(true);
  });

  it("is all or nothing when a page changes meanwhile: nothing restarted, session not restored", async () => {
    const s = await stage({
      label: "restore-changed",
      session: "FAILED",
      rows: { 2: [[0, "FAILED", 60]], 3: [[0, "QUEUED", 5]] },
    });
    fake.onGetJob = async (id) => {
      if (id === s.rows["3:0"]) {
        await prisma.pageVersion.update({
          where: { id },
          data: { status: "TEXT_STAMPING" },
        });
      }
    };
    const err = await refusal(
      regenerateOrderPages(s.orderId, ADMIN, { force: true })
    );
    expect(err?.statusCode).toBe(409);
    expect((await readRow(s, "2:0")).status).toBe("FAILED");
    expect(await sessionStatus(s)).toBe("FAILED");
    expect(fake.addBulk).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: a payment whose follow-up work never finished", () => {
  it("(PAID, PAID) for over 10 minutes: creates the paid pages' rows (not the preview page), queues them, then moves the session on and sends the payment email once", async () => {
    const s = await stage({
      label: "stalled",
      session: "PAID",
      orderAgeMinutes: 30,
      rows: {},
    });
    const result = await regenerateOrderPages(s.orderId, ADMIN, {});
    expect(result.queued.map((q) => q.pageNumber).sort()).toEqual([2, 3, 4, 5]);
    expect(result.sessionRestored).toBe(true);
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
    expect(
      await prisma.pageVersion.count({
        where: { orderSessionId: s.sessionId, pageId: s.pages[1]! },
      })
    ).toBe(0);
    expect(fake.notifyPaymentReceived).toHaveBeenCalledTimes(1);
  });

  it("does not move the session when the queue refuses the jobs (the webhook's order)", async () => {
    const s = await stage({
      label: "stalled-fail",
      session: "PAID",
      orderAgeMinutes: 30,
      rows: {},
    });
    fake.addBulk.mockRejectedValueOnce(new Error("redis exploded"));
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(503);
    expect(await sessionStatus(s)).toBe("PAID");
    expect(fake.notifyPaymentReceived).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: the queue failing", () => {
  it("a rejected add puts the rows back to failed (settled), says so, and answers 503", async () => {
    const s = await stage({
      label: "rejected",
      rows: {
        ...finished(1, 4, 5),
        2: [[0, "FAILED", 60]],
        3: [[0, "FAILED", 60]],
      },
    });
    fake.addBulk.mockRejectedValueOnce(new Error("redis exploded"));
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(503);
    expect(err?.message).toMatch(/put back to failed.*10 minutes/);
    expect(fake.settle).toHaveBeenCalledTimes(2);
    expect(fake.settle).toHaveBeenCalledWith(
      s.rows["2:0"],
      "Could not be queued",
      expect.objectContaining({
        source: "admin-regenerate",
        staleBefore: expect.any(Date),
      })
    );
  });

  it("a timeout does NOT compensate (the command may still run) and says so", async () => {
    const s = await stage({
      label: "timeout",
      rows: { 2: [[0, "FAILED", 60]] },
    });
    fake.addBulk.mockImplementationOnce(() => new Promise(() => {}));
    const err = await refusal(regenerateOrderPages(s.orderId, ADMIN, {}));
    expect(err?.statusCode).toBe(503);
    expect(err?.message).toBe(
      "The restart may still start in a few minutes; check the order page."
    );
    expect(fake.settle).not.toHaveBeenCalled();
    expect((await readRow(s, "2:0")).status).toBe("QUEUED");
  });
});

// ---------------------------------------------------------------------------------------

describe("POST restart: finishing an order whose pages are all done", () => {
  for (const session of ["FAILED", "GENERATING_PAID"] as const) {
    it(`(PAID, ${session}) with every page finished: moves the order on, tells the browser and emails once`, async () => {
      const s = await stage({
        label: `repair-${session}`,
        session,
        rows: {
          1: [[0, "SD_READY", 90]],
          2: [[0, "SD_READY", 90]],
          3: [[0, "SD_READY", 90]],
          4: [[0, "SD_READY", 90]],
          5: [[0, "SD_READY", 90]],
        },
      });
      const before = await getOrderPageStatus(s.orderId);
      expect(before.needsRepair).toBe(true);
      const result = await regenerateOrderPages(s.orderId, ADMIN, {});
      expect(result.repaired).toBe(true);
      expect(await sessionStatus(s)).toBe("PAID_PAGES_READY");
      expect((await orderRow(s)).status).toBe("GENERATED");
      expect(fake.emitPaidReady).toHaveBeenCalledTimes(1);
      expect(fake.notifyBookReady).toHaveBeenCalledTimes(1);
      expect(fake.addBulk).not.toHaveBeenCalled();
    });
  }

  it("a healthy finished order (GENERATED) needs no repair and restarts nothing", async () => {
    const s = await stage({
      label: "nothing",
      order: "GENERATED",
      session: "PAID_PAGES_READY",
      rows: {
        1: [[0, "SD_READY", 90]],
        2: [[0, "SD_READY", 90]],
        3: [[0, "SD_READY", 90]],
        4: [[0, "SD_READY", 90]],
        5: [[0, "SD_READY", 90]],
      },
    });
    expect((await getOrderPageStatus(s.orderId)).needsRepair).toBe(false);
    const result = await regenerateOrderPages(s.orderId, ADMIN, {});
    expect(result.queued).toHaveLength(0);
    expect(result.repaired).toBe(false);
  });
});
