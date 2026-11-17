// Integration tests for maybeMarkPaidReady: the book is announced as ready only
// when every paid page has settled AND no row of a paid page is still being made.
// A page that keeps an old FAILED variant used to count as settled while a newer
// variant was still running. They run against the Neon TEST branch only:
// the setup import below refuses any other database.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { maybeMarkPaidReady } from "../../src/services/session.service.js";
import type { PageVersionStatus } from "../../src/generated/prisma/client.js";

const MARK = "__vitest_paidready__";
const RUN = Math.random().toString(36).slice(2, 8);

const comicIds: string[] = [];
const sessionIds: string[] = [];
const userIds: string[] = [];

type Staged = {
  sessionId: string;
  orderId: string;
  pages: Record<number, string>;
};

/** A paid session in GENERATING_PAID with one preview page (1) and paid pages 2, 3, 4. */
async function stage(label: string): Promise<Staged> {
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
      status: "GENERATING_PAID",
      coverType: "HARDCOVER",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: 999,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
      status: "PAID",
      shippingName: `${MARK} ${RUN}`,
    },
  });
  return { sessionId: session.id, orderId: order.id, pages };
}

const row = (
  s: Staged,
  page: number,
  variantIndex: number,
  status: PageVersionStatus
) =>
  prisma.pageVersion.create({
    data: {
      orderSessionId: s.sessionId,
      pageId: s.pages[page]!,
      variantIndex,
      status,
    },
  });

const states = async (s: Staged) => {
  const session = await prisma.orderSession.findUniqueOrThrow({
    where: { id: s.sessionId },
  });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: s.orderId },
  });
  return { session: session.status, order: order.status };
};

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

describe("maybeMarkPaidReady", () => {
  it("is not ready while a newer variant of a page is still being made, even if an older variant failed", async () => {
    const s = await stage("history");
    await row(s, 1, 0, "SD_READY"); // the preview page
    await row(s, 2, 0, "FAILED"); // old failed variant
    await row(s, 2, 1, "QUEUED"); // newer variant, still running
    await row(s, 3, 0, "SD_READY");
    await row(s, 4, 0, "FAILED");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("not-done");
    expect(await states(s)).toEqual({
      session: "GENERATING_PAID",
      order: "PAID",
    });
  });

  it("becomes ready once that variant has finished", async () => {
    const s = await stage("history-done");
    await row(s, 1, 0, "SD_READY");
    await row(s, 2, 0, "FAILED");
    const running = await row(s, 2, 1, "GENERATING_SD");
    await row(s, 3, 0, "SD_READY");
    await row(s, 4, 0, "FAILED");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("not-done");
    await prisma.pageVersion.update({
      where: { id: running.id },
      data: { status: "SD_READY" },
    });
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("ready");
    expect(await states(s)).toEqual({
      session: "PAID_PAGES_READY",
      order: "GENERATED",
    });
  });

  it("is not ready while a page restarted in place (a single row) is running", async () => {
    const s = await stage("in-place");
    await row(s, 1, 0, "SD_READY");
    await row(s, 2, 0, "QUEUED");
    await row(s, 3, 0, "SD_READY");
    await row(s, 4, 0, "FAILED");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("not-done");
    expect(await states(s)).toEqual({
      session: "GENERATING_PAID",
      order: "PAID",
    });
  });

  it("every state that is still in flight holds the flip back", async () => {
    for (const status of [
      "QUEUED",
      "TEXT_STAMPING",
      "TEXT_STAMPED",
      "GENERATING_SD",
    ] as const) {
      const s = await stage(`flight-${status}`);
      await row(s, 2, 0, "SD_READY");
      await row(s, 3, 0, "FAILED");
      await row(s, 3, 1, status);
      await row(s, 4, 0, "SD_READY");
      expect(await maybeMarkPaidReady(s.sessionId), status).toBe("not-done");
    }
  });

  it("is ready when every paid page has settled and one succeeded (failed pages do not block)", async () => {
    const s = await stage("settled");
    await row(s, 1, 0, "SD_READY");
    await row(s, 2, 0, "SD_READY");
    await row(s, 3, 0, "FAILED");
    await row(s, 4, 0, "FAILED");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("ready");
    expect(await states(s)).toEqual({
      session: "PAID_PAGES_READY",
      order: "GENERATED",
    });
  });

  it("marks the session FAILED, and leaves the order PAID, when every paid page failed", async () => {
    const s = await stage("all-failed");
    await row(s, 1, 0, "SD_READY");
    await row(s, 2, 0, "FAILED");
    await row(s, 3, 0, "FAILED");
    await row(s, 4, 0, "FAILED");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("failed");
    expect(await states(s)).toEqual({ session: "FAILED", order: "PAID" });
  });

  it("is not held back by a row of the preview page that is still running", async () => {
    const s = await stage("preview-running");
    await row(s, 1, 0, "GENERATING_SD"); // preview page, not a paid page
    await row(s, 2, 0, "SD_READY");
    await row(s, 3, 0, "SD_READY");
    await row(s, 4, 0, "SD_READY");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("ready");
  });

  it("is not held back by a running row of ANOTHER session", async () => {
    const mine = await stage("mine");
    const other = await stage("other");
    await row(other, 2, 0, "QUEUED");
    await row(mine, 2, 0, "SD_READY");
    await row(mine, 3, 0, "SD_READY");
    await row(mine, 4, 0, "SD_READY");
    expect(await maybeMarkPaidReady(mine.sessionId)).toBe("ready");
  });

  it("flips only once: a second call after the flip does nothing", async () => {
    const s = await stage("once");
    await row(s, 2, 0, "SD_READY");
    await row(s, 3, 0, "SD_READY");
    await row(s, 4, 0, "SD_READY");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("ready");
    expect(await maybeMarkPaidReady(s.sessionId)).toBe("not-done");
  });
});
