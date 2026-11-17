// Integration tests for the customer's regeneratePage on a session that FAILED
// after payment. It used to move such a session to GENERATING_PREVIEW; the free
// preview pages were all done, so it jumped to PREVIEW_READY, the order stayed
// PAID and the book could never be printed (BUG-008). They run against the Neon
// TEST branch only: the setup import below refuses any other database. The job
// queue is replaced by a stub, so nothing reaches Redis.
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

const { addBulk } = vi.hoisted(() => ({ addBulk: vi.fn(async () => []) }));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk, getJob: vi.fn(async () => null) },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  maybeMarkPaidReady,
  regeneratePage,
} from "../../src/services/session.service.js";
import type {
  OrderSessionStatus,
  OrderStatus,
  PageVersionStatus,
} from "../../src/generated/prisma/client.js";

const MARK = "__vitest_regenpaid__";
const RUN = Math.random().toString(36).slice(2, 8);

const comicIds: string[] = [];
const sessionIds: string[] = [];
const userIds: string[] = [];

type Staged = {
  sessionId: string;
  orderId: string | null;
  pages: Record<number, string>;
};

/** Pages 1 (preview), 2, 3, 4 (paid). Preview page finished; paid pages as given. */
async function stage(opts: {
  label: string;
  session: OrderSessionStatus;
  order: OrderStatus | null;
  paidPages: PageVersionStatus;
  expired?: boolean;
}): Promise<Staged> {
  const userId = `${MARK}-${RUN}-${opts.label}`;
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  userIds.push(userId);
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} ${opts.label}`,
      pageCount: 4,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicIds.push(comic.id);
  const pages: Record<number, string> = {};
  for (const n of [1, 2, 3, 4]) {
    const page = await prisma.page.create({
      data: { comicId: comic.id, pageNumber: n, isPreviewPage: n === 1 },
    });
    pages[n] = page.id;
  }
  const session = await prisma.orderSession.create({
    data: {
      comicId: comic.id,
      userId,
      status: opts.session,
      coverType: "HARDCOVER",
      expiresAt: new Date(
        Date.now() + (opts.expired ? -1 : 1) * 24 * 60 * 60 * 1000
      ),
    },
  });
  sessionIds.push(session.id);
  await prisma.sessionPage.createMany({
    data: [1, 2, 3, 4].map((n) => ({
      orderSessionId: session.id,
      pageId: pages[n]!,
      isPreviewPage: n === 1,
    })),
  });
  await prisma.pageVersion.createMany({
    data: [1, 2, 3, 4].map((n) => ({
      orderSessionId: session.id,
      pageId: pages[n]!,
      variantIndex: 0,
      status: n === 1 ? ("SD_READY" as const) : opts.paidPages,
    })),
  });
  let orderId: string | null = null;
  if (opts.order) {
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: 999,
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: opts.order,
        shippingName: `${MARK} ${RUN}`,
      },
    });
    orderId = order.id;
  }
  return { sessionId: session.id, orderId, pages };
}

const sessionStatus = async (s: Staged) =>
  (await prisma.orderSession.findUniqueOrThrow({ where: { id: s.sessionId } }))
    .status;

beforeEach(() => addBulk.mockClear());

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

describe("regeneratePage on a session that FAILED after payment", () => {
  it("moves it back to GENERATING_PAID, reports hasPaid and queues the page", async () => {
    const s = await stage({
      label: "paid-failed",
      session: "FAILED",
      order: "PAID",
      paidPages: "FAILED",
    });
    const result = await regeneratePage(s.sessionId, 2);
    expect(result).toMatchObject({
      queued: true,
      pageNumber: 2,
      variantIndex: 1,
      hasPaid: true,
    });
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
    expect(addBulk).toHaveBeenCalledTimes(1);
  });

  it("uses the paid cap of 8 variants, not the free cap of 3", async () => {
    const s = await stage({
      label: "paid-cap",
      session: "FAILED",
      order: "PAID",
      paidPages: "FAILED",
    });
    for (const variantIndex of [1, 2]) {
      await prisma.pageVersion.create({
        data: {
          orderSessionId: s.sessionId,
          pageId: s.pages[2]!,
          variantIndex,
          status: "FAILED",
        },
      });
    }
    // three variants exist: the free cap would refuse a fourth
    const result = await regeneratePage(s.sessionId, 2);
    expect(result.variantIndex).toBe(3);
  });

  it("is allowed after the session's 7 days, because a paid session does not expire", async () => {
    const s = await stage({
      label: "paid-expired",
      session: "FAILED",
      order: "PAID",
      paidPages: "FAILED",
      expired: true,
    });
    const result = await regeneratePage(s.sessionId, 3);
    expect(result.hasPaid).toBe(true);
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
  });

  it("ends at PAID_PAGES_READY and GENERATED when the page succeeds: no dead end", async () => {
    const s = await stage({
      label: "paid-recover",
      session: "FAILED",
      order: "PAID",
      paidPages: "FAILED",
    });
    await regeneratePage(s.sessionId, 2);
    await prisma.pageVersion.updateMany({
      where: {
        orderSessionId: s.sessionId,
        pageId: s.pages[2]!,
        variantIndex: 1,
      },
      data: { status: "SD_READY" },
    });
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("ready");
    expect(await sessionStatus(s)).toBe("PAID_PAGES_READY");
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: s.orderId! },
    });
    expect(order.status).toBe("GENERATED");
  });

  it("two regenerations at the same moment both queue and the session ends GENERATING_PAID", async () => {
    const s = await stage({
      label: "paid-double",
      session: "FAILED",
      order: "PAID",
      paidPages: "FAILED",
    });
    const results = await Promise.allSettled([
      regeneratePage(s.sessionId, 2),
      regeneratePage(s.sessionId, 3),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
  });
});

describe("regeneratePage everywhere else behaves as before", () => {
  it("a FAILED session that was never paid (order not paid, or none) still goes to GENERATING_PREVIEW with the free cap", async () => {
    for (const order of [null, "CREATED"] as const) {
      const s = await stage({
        label: `unpaid-${order}`,
        session: "FAILED",
        order,
        paidPages: "FAILED",
      });
      const result = await regeneratePage(s.sessionId, 2);
      expect(result.hasPaid).toBe(false);
      expect(await sessionStatus(s)).toBe("GENERATING_PREVIEW");
    }
  });

  it("a FAILED session that was never paid is still refused once it has expired", async () => {
    const s = await stage({
      label: "unpaid-expired",
      session: "FAILED",
      order: null,
      paidPages: "FAILED",
      expired: true,
    });
    await expect(regeneratePage(s.sessionId, 2)).rejects.toThrow(/expired/i);
  });

  it("a GENERATING_PAID session stays GENERATING_PAID and reports hasPaid", async () => {
    const s = await stage({
      label: "gen-paid",
      session: "GENERATING_PAID",
      order: "PAID",
      paidPages: "FAILED",
    });
    const result = await regeneratePage(s.sessionId, 2);
    expect(result.hasPaid).toBe(true);
    expect(await sessionStatus(s)).toBe("GENERATING_PAID");
  });

  it("a PREVIEW_READY session stays PREVIEW_READY and reports hasPaid false", async () => {
    const s = await stage({
      label: "preview-ready",
      session: "PREVIEW_READY",
      order: null,
      paidPages: "QUEUED",
    });
    const result = await regeneratePage(s.sessionId, 1);
    expect(result.hasPaid).toBe(false);
    expect(await sessionStatus(s)).toBe("PREVIEW_READY");
  });

  it("a session in a status that cannot regenerate is still refused", async () => {
    const s = await stage({
      label: "awaiting",
      session: "AWAITING_PAYMENT",
      order: "CREATED",
      paidPages: "QUEUED",
    });
    await expect(regeneratePage(s.sessionId, 2)).rejects.toThrow(
      /Cannot regenerate/
    );
  });
});
