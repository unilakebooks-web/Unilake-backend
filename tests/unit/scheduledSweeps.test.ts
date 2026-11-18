import { describe, it, expect, vi, beforeEach } from "vitest";

const sweeps = vi.hoisted(() => ({
  sessions: vi.fn(),
  pages: vi.fn(),
  coupons: vi.fn(),
}));
vi.mock("../../src/services/session.service.js", () => ({
  sweepExpiredSessions: sweeps.sessions,
}));
vi.mock("../../src/jobs/workers/stuckPageSweeper.js", () => ({
  sweepStuckPageVersions: sweeps.pages,
}));
vi.mock("../../src/services/coupon.service.js", () => ({
  sweepExpiredCoupons: sweeps.coupons,
}));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logger } from "../../src/lib/logger.js";
import {
  runScheduledSweeps,
  SWEEP_TIMEOUT_MS,
} from "../../src/services/scheduledSweeps.service.js";

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  sweeps.sessions.mockReset().mockResolvedValue(2);
  sweeps.pages.mockReset().mockResolvedValue(1);
  sweeps.coupons.mockReset().mockResolvedValue(0);
});

describe("runScheduledSweeps", () => {
  it("runs the three sweeps in order and reports each count", async () => {
    const order: string[] = [];
    sweeps.sessions.mockImplementation(async () => (order.push("sessions"), 2));
    sweeps.pages.mockImplementation(async () => (order.push("pages"), 1));
    sweeps.coupons.mockImplementation(async () => (order.push("coupons"), 0));
    const out = await runScheduledSweeps();
    expect(out.skipped).toBe(false);
    expect(order).toEqual(["sessions", "pages", "coupons"]);
    expect(out.results.map((r) => [r.name, r.count, r.error])).toEqual([
      ["expired sessions", 2, null],
      ["stuck pages", 1, null],
      ["expired coupons", 0, null],
    ]);
  });

  it("a failing sweep is reported and does not stop the others", async () => {
    sweeps.pages.mockRejectedValue(
      new Error('database is down: relation "pages" detail')
    );
    const out = await runScheduledSweeps();
    expect(sweeps.sessions).toHaveBeenCalledTimes(1);
    expect(sweeps.coupons).toHaveBeenCalledTimes(1);
    expect(out.results[1]).toMatchObject({
      name: "stuck pages",
      count: null,
      error: "failed",
    });
    expect(out.results[0]?.error).toBeNull();
    expect(out.results[2]?.error).toBeNull();
  });

  it("a second call while one is running does nothing, and runs again once it finished", async () => {
    let release!: () => void;
    sweeps.sessions.mockImplementation(
      () => new Promise<number>((r) => (release = () => r(5)))
    );
    const first = runScheduledSweeps();
    await Promise.resolve();
    const second = await runScheduledSweeps();
    expect(second).toEqual({ skipped: true, results: [] });
    expect(sweeps.pages).not.toHaveBeenCalled();
    release();
    const done = await first;
    expect(done.skipped).toBe(false);
    sweeps.sessions.mockResolvedValue(0);
    const again = await runScheduledSweeps();
    expect(again.skipped).toBe(false);
  });

  it("lets the next run start after a run where every sweep failed", async () => {
    for (const f of Object.values(sweeps))
      f.mockRejectedValue(new Error("boom"));
    const bad = await runScheduledSweeps();
    expect(bad.results.every((r) => r.error === "failed")).toBe(true);
    for (const f of Object.values(sweeps)) f.mockResolvedValue(0);
    expect((await runScheduledSweeps()).skipped).toBe(false);
  });

  it("never puts the raw error text of a failing sweep into the result", async () => {
    sweeps.coupons.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.1:5432 secret-detail")
    );
    const out = await runScheduledSweeps();
    expect(JSON.stringify(out)).not.toMatch(/ECONNREFUSED|secret-detail/);
  });

  it("a sweep that never answers is reported as timed out and does not block the next run", async () => {
    vi.useFakeTimers();
    try {
      sweeps.pages.mockImplementation(() => new Promise<number>(() => {}));
      const run = runScheduledSweeps();
      await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS + 1);
      const out = await run;
      expect(out.results.map((r) => [r.name, r.error])).toEqual([
        ["expired sessions", null],
        ["stuck pages", "timed out"],
        ["expired coupons", null],
      ]);
      sweeps.pages.mockResolvedValue(0);
      const next = await runScheduledSweeps();
      expect(next.skipped).toBe(false);
      expect(next.results.every((r) => r.error === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a warning when a call is skipped because a run is in progress", async () => {
    let release!: () => void;
    sweeps.sessions.mockImplementation(
      () => new Promise<number>((r) => (release = () => r(0)))
    );
    const first = runScheduledSweeps();
    await Promise.resolve();
    await runScheduledSweeps();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
