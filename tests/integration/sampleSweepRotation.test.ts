// A sample whose cleanup keeps failing must not starve the others. Separate file because it shrinks the
// sweep batch to one sample for the whole file. Test branch and local MinIO only.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {
    addBulk: vi.fn(async () => []),
    getJob: vi.fn(async () => null),
  },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
// The budget can be changed per test (a getter is read at each use); the real value is put back after.
const tuning = vi.hoisted(() => ({ budgetMs: 0, realBudgetMs: 0 }));
vi.mock("../../src/config/sample.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/config/sample.js")>();
  tuning.realBudgetMs = real.SAMPLE_SWEEP_BUDGET_MS;
  tuning.budgetMs = real.SAMPLE_SWEEP_BUDGET_MS;
  return {
    ...real,
    SAMPLE_SWEEP_BATCH: 1,
    get SAMPLE_SWEEP_BUDGET_MS() {
      return tuning.budgetMs;
    },
  };
});

import { prisma } from "../../src/lib/prisma.js";
import { r2Client } from "../../src/lib/r2.js";
import { sweepSampleSessions } from "../../src/jobs/workers/sampleSweeper.js";
import {
  SAMPLE_CLEANUP_MARGIN_MS,
  SAMPLE_SWEEP_STALE_MS,
} from "../../src/config/sample.js";

const MARK = "__vitest_sample_rotation__";
let comicId = "";

async function cleanup() {
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  comicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} ${Math.random().toString(36).slice(2, 8)}`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const exists = async (id: string) =>
  (await prisma.orderSession.count({ where: { id } })) === 1;

describe("sample sweep with a sample that always fails", () => {
  it("moves the failing sample to the back, so the next sample is reached", async () => {
    const over = new Date(Date.now() - SAMPLE_CLEANUP_MARGIN_MS - 60_000);
    const bad = await prisma.orderSession.create({
      data: {
        comicId,
        isSample: true,
        expiresAt: over,
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const good = await prisma.orderSession.create({
      data: {
        comicId,
        isSample: true,
        expiresAt: over,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    // Storage refuses only the failing sample's folder.
    const original = r2Client.send.bind(r2Client);
    (r2Client as { send: unknown }).send = async (cmd: {
      input?: { Prefix?: string };
    }) => {
      if (cmd.input?.Prefix?.includes(bad.id))
        throw new Error("storage refuses this folder");
      return original(cmd as never);
    };
    try {
      // Batch of one: the oldest (the failing one) is tried first and fails loudly.
      await expect(sweepSampleSessions()).rejects.toThrow(
        /cleanup failed for 1/
      );
      expect(await exists(bad.id)).toBe(true);
      expect(await exists(good.id)).toBe(true);
      // The next run reaches the other sample instead of the same failing one.
      await sweepSampleSessions();
      expect(await exists(good.id)).toBe(false);
      expect(await exists(bad.id)).toBe(true);
    } finally {
      (r2Client as { send: unknown }).send = original;
    }
    await sweepSampleSessions();
    expect(await exists(bad.id)).toBe(false);
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const makeOver = () =>
  prisma.orderSession.create({
    data: {
      comicId,
      isSample: true,
      expiresAt: new Date(Date.now() - SAMPLE_CLEANUP_MARGIN_MS - 60_000),
    },
  });

/** Makes the first storage call for this sample wait until released; the rest go through. */
function stallFirstCallFor(sessionId: string) {
  let release: () => void = () => undefined;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = r2Client.send.bind(r2Client);
  let first = true;
  (r2Client as { send: unknown }).send = async (cmd: {
    input?: { Prefix?: string };
  }) => {
    if (first && cmd.input?.Prefix?.includes(sessionId)) {
      first = false;
      await hang;
    }
    return original(cmd as never);
  };
  return {
    release,
    restore: () => {
      (r2Client as { send: unknown }).send = original;
    },
  };
}

describe("sample sweep running state", () => {
  it("a run that throws does not leave the sweep blocked", async () => {
    const s = await makeOver();
    const original = r2Client.send.bind(r2Client);
    (r2Client as { send: unknown }).send = async () => {
      throw new Error("storage down");
    };
    try {
      await expect(sweepSampleSessions()).rejects.toThrow(/cleanup failed/);
      // Had the marker stayed set, this second call would return 0 instead of trying (and failing) again.
      await expect(sweepSampleSessions()).rejects.toThrow(/cleanup failed/);
    } finally {
      (r2Client as { send: unknown }).send = original;
    }
    await sweepSampleSessions();
    expect(await exists(s.id)).toBe(false);
  });

  it("a second call while a run is in progress does nothing", async () => {
    const s = await makeOver();
    const stall = stallFirstCallFor(s.id);
    try {
      const first = sweepSampleSessions();
      await wait(500);
      expect(await sweepSampleSessions()).toBe(0);
      stall.release();
      expect(await first).toBe(1);
    } finally {
      stall.restore();
    }
    expect(await exists(s.id)).toBe(false);
  });

  it("a run older than the stale window is taken over, and the old run does not block the next one", async () => {
    const s = await makeOver();
    const stall = stallFirstCallFor(s.id);
    const realNow = Date.now.bind(Date);
    try {
      const first = sweepSampleSessions();
      await wait(500);
      const spy = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realNow() + SAMPLE_SWEEP_STALE_MS + 50_000);
      let takeover: number;
      try {
        takeover = await sweepSampleSessions();
      } finally {
        spy.mockRestore();
      }
      expect(takeover).toBe(1);
      stall.release();
      expect(await first).toBe(0);
    } finally {
      stall.restore();
    }
    const next = await makeOver();
    expect(await sweepSampleSessions()).toBe(1);
    expect(await exists(next.id)).toBe(false);
  });

  it("a run whose time budget is spent starts no new sample", async () => {
    const s = await makeOver();
    tuning.budgetMs = -1;
    try {
      expect(await sweepSampleSessions()).toBe(0);
      expect(await exists(s.id)).toBe(true);
    } finally {
      tuning.budgetMs = tuning.realBudgetMs;
    }
    expect(await sweepSampleSessions()).toBe(1);
    expect(await exists(s.id)).toBe(false);
  });
});
