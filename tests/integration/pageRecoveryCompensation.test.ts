// The restart tool puts rows back to FAILED when the queue rejects the add. That goes through
// the REAL settleTerminalPageFailure (generationWorker.ts) and, through it, the real
// maybeMarkPaidReady: these tests run that path against the Neon TEST branch (the setup import
// below refuses any other database). Only the queue library, Redis, the websocket and the emails
// are replaced, so importing the worker module starts nothing.
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

const fake = vi.hoisted(() => ({
  emitPaidReady: vi.fn(),
  emitPageError: vi.fn(),
  notifyBookReady: vi.fn(async () => ({})),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
  Queue: class {
    add() {
      return Promise.resolve();
    }
    addBulk() {
      return Promise.resolve([]);
    }
    getJob() {
      return Promise.resolve(null);
    }
  },
}));
vi.mock("../../src/lib/redis.js", () => ({
  redisClient: { status: "ready", on: () => undefined },
}));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {
    add: vi.fn(),
    addBulk: vi.fn(),
    getJob: vi.fn(async () => null),
  },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/websocket/event.js", () => ({
  emitPageReady: vi.fn(),
  emitPageError: fake.emitPageError,
  emitSessionPreviewReady: vi.fn(),
  emitSessionPaidReady: fake.emitPaidReady,
}));
vi.mock("../../src/services/notification.service.js", () => ({
  notifyBookReady: fake.notifyBookReady,
  notifyPreviewReady: vi.fn(async () => ({})),
  notifyPaymentReceived: vi.fn(async () => ({})),
  notifySentToPrint: vi.fn(),
}));

import { prisma } from "../../src/lib/prisma.js";
import { settleTerminalPageFailure } from "../../src/jobs/workers/generationWorker.js";
import type {
  OrderSessionStatus,
  PageVersionStatus,
} from "../../src/generated/prisma/client.js";

const MARK = "__vitest_compensation__";
const RUN = Math.random().toString(36).slice(2, 8);
const comicIds: string[] = [];
const sessionIds: string[] = [];
const userIds: string[] = [];

async function stage(
  label: string,
  session: OrderSessionStatus,
  rows: Record<number, PageVersionStatus>
) {
  const userId = `${MARK}-${RUN}-${label}`;
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  userIds.push(userId);
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} ${label}`,
      pageCount: 4,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicIds.push(comic.id);
  const pageIds: Record<number, string> = {};
  for (const n of [1, 2, 3, 4]) {
    pageIds[n] = (
      await prisma.page.create({
        data: { comicId: comic.id, pageNumber: n, isPreviewPage: n === 1 },
      })
    ).id;
  }
  const sess = await prisma.orderSession.create({
    data: {
      comicId: comic.id,
      userId,
      status: session,
      coverType: "HARDCOVER",
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  sessionIds.push(sess.id);
  await prisma.sessionPage.createMany({
    data: [1, 2, 3, 4].map((n) => ({
      orderSessionId: sess.id,
      pageId: pageIds[n]!,
      isPreviewPage: n === 1,
    })),
  });
  const order = await prisma.order.create({
    data: {
      orderSessionId: sess.id,
      amount: 999,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
      status: "PAID",
      shippingName: `${MARK} ${RUN}`,
    },
  });
  const ids: Record<number, string> = {};
  for (const [n, status] of Object.entries(rows)) {
    ids[Number(n)] = (
      await prisma.pageVersion.create({
        data: {
          orderSessionId: sess.id,
          pageId: pageIds[Number(n)]!,
          variantIndex: 0,
          status,
        },
      })
    ).id;
  }
  return { sessionId: sess.id, orderId: order.id, ids };
}

const status = async (id: string) =>
  (await prisma.pageVersion.findUniqueOrThrow({ where: { id } })).status;
const session = async (sessionId: string) =>
  (await prisma.orderSession.findUniqueOrThrow({ where: { id: sessionId } }))
    .status;

beforeEach(() => {
  fake.emitPaidReady.mockClear();
  fake.emitPageError.mockClear();
  fake.notifyBookReady.mockClear();
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

describe("putting restarted rows back after the queue rejected the add (real settleTerminalPageFailure)", () => {
  const opts = () => ({
    source: "admin-regenerate" as const,
    staleBefore: new Date(Date.now() + 1000),
  });

  it("writes FAILED on a just-reset row; when every paid page failed the session goes back to FAILED and the order stays PAID", async () => {
    const s = await stage("all-failed", "GENERATING_PAID", {
      1: "SD_READY",
      2: "QUEUED",
      3: "QUEUED",
      4: "QUEUED",
    });
    for (const n of [2, 3, 4])
      await settleTerminalPageFailure(s.ids[n]!, "Could not be queued", opts());
    for (const n of [2, 3, 4]) expect(await status(s.ids[n]!)).toBe("FAILED");
    expect(await session(s.sessionId)).toBe("FAILED");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } }))
        .status
    ).toBe("PAID");
    expect(fake.notifyBookReady).not.toHaveBeenCalled();
  });

  it("does not touch a row that moved on after the reset (the staleBefore guard)", async () => {
    const s = await stage("moved-on", "GENERATING_PAID", {
      1: "SD_READY",
      2: "SD_READY",
      3: "QUEUED",
      4: "QUEUED",
    });
    // the worker picked page 3 up just after the reset: its updatedAt is now AFTER the cut-off
    await prisma.pageVersion.update({
      where: { id: s.ids[3]! },
      data: { status: "TEXT_STAMPING" },
    });
    await settleTerminalPageFailure(s.ids[3]!, "Could not be queued", {
      source: "admin-regenerate",
      staleBefore: new Date(Date.now() - 60_000),
    });
    expect(await status(s.ids[3]!)).toBe("TEXT_STAMPING");
  });

  it("DOCUMENTED RULE (success wins): if some paid page already succeeded, putting the others back makes the book 'ready' and emails the customer", async () => {
    const s = await stage("success-wins", "GENERATING_PAID", {
      1: "SD_READY",
      2: "SD_READY",
      3: "QUEUED",
      4: "QUEUED",
    });
    for (const n of [3, 4])
      await settleTerminalPageFailure(s.ids[n]!, "Could not be queued", opts());
    expect(await session(s.sessionId)).toBe("PAID_PAGES_READY");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } }))
        .status
    ).toBe("GENERATED");
    expect(fake.notifyBookReady).toHaveBeenCalledTimes(1);
  });
});
