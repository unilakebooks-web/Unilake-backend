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

import { runScheduledSweeps } from "../../src/services/scheduledSweeps.service.js";

beforeEach(() => {
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
    sweeps.pages.mockRejectedValue(new Error("database is down"));
    const out = await runScheduledSweeps();
    expect(sweeps.sessions).toHaveBeenCalledTimes(1);
    expect(sweeps.coupons).toHaveBeenCalledTimes(1);
    expect(out.results[1]).toMatchObject({
      name: "stuck pages",
      count: null,
      error: "database is down",
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
    expect(bad.results.every((r) => r.error === "boom")).toBe(true);
    for (const f of Object.values(sweeps)) f.mockResolvedValue(0);
    expect((await runScheduledSweeps()).skipped).toBe(false);
  });
});
