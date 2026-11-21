import { describe, it, expect, vi, beforeEach } from "vitest";

const sweeps = vi.hoisted(() => ({
  sessions: vi.fn(),
  pages: vi.fn(),
  coupons: vi.fn(),
  samples: vi.fn(),
  deletion: vi.fn(),
  reminders: vi.fn(),
  broadcasts: vi.fn(),
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
vi.mock("../../src/jobs/workers/sampleSweeper.js", () => ({
  sweepSampleSessions: sweeps.samples,
}));
vi.mock("../../src/services/dataDeletion.service.js", () => ({
  sweepDataDeletion: sweeps.deletion,
}));
vi.mock("../../src/services/reminder.service.js", () => ({
  sweepReminders: sweeps.reminders,
}));
vi.mock("../../src/services/broadcast.service.js", () => ({
  sweepBroadcasts: sweeps.broadcasts,
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
  sweeps.samples.mockReset().mockResolvedValue(3);
  sweeps.deletion.mockReset().mockResolvedValue(6);
  sweeps.reminders.mockReset().mockResolvedValue(4);
  sweeps.broadcasts.mockReset().mockResolvedValue(5);
});

describe("runScheduledSweeps", () => {
  it("runs the seven sweeps in order and reports each count", async () => {
    const order: string[] = [];
    sweeps.sessions.mockImplementation(async () => (order.push("sessions"), 2));
    sweeps.pages.mockImplementation(async () => (order.push("pages"), 1));
    sweeps.coupons.mockImplementation(async () => (order.push("coupons"), 0));
    sweeps.samples.mockImplementation(async () => (order.push("samples"), 3));
    sweeps.deletion.mockImplementation(async () => (order.push("deletion"), 6));
    sweeps.reminders.mockImplementation(async () => (order.push("reminders"), 4));
    sweeps.broadcasts.mockImplementation(async () => (order.push("broadcasts"), 5));
    const out = await runScheduledSweeps();
    expect(out.skipped).toBe(false);
    expect(order).toEqual(["sessions", "pages", "coupons", "samples", "deletion", "reminders", "broadcasts"]);
    expect(out.results.map((r) => [r.name, r.count, r.error])).toEqual([
      ["expired sessions", 2, null],
      ["stuck pages", 1, null],
      ["expired coupons", 0, null],
      ["sample books", 3, null],
      ["data deletion", 6, null],
      ["reminder emails", 4, null],
      ["broadcast emails", 5, null],
    ]);
  });

  it("a failing reminder sweep is reported and the five sweeps before it still ran", async () => {
    sweeps.reminders.mockRejectedValue(new Error("resend is down"));
    const out = await runScheduledSweeps();
    expect(sweeps.sessions).toHaveBeenCalledTimes(1);
    expect(sweeps.pages).toHaveBeenCalledTimes(1);
    expect(sweeps.coupons).toHaveBeenCalledTimes(1);
    expect(sweeps.samples).toHaveBeenCalledTimes(1);
    expect(sweeps.deletion).toHaveBeenCalledTimes(1);
    const before = out.results.filter((r) => r.name !== "reminder emails" && r.name !== "broadcast emails");
    expect(before).toHaveLength(5);
    expect(before.every((r) => r.error === null)).toBe(true);
    expect(out.results.find((r) => r.name === "reminder emails")).toMatchObject({ count: null, error: "failed" });
    expect(JSON.stringify(out)).not.toContain("resend is down");
  });

  it("a failing reminder sweep does not stop the broadcast sweep that follows it", async () => {
    sweeps.reminders.mockRejectedValue(new Error("resend is down"));
    const out = await runScheduledSweeps();
    expect(sweeps.broadcasts).toHaveBeenCalledTimes(1);
    expect(out.results.find((r) => r.name === "broadcast emails")).toMatchObject({ count: 5, error: null });
  });

  it("a failing sweep is reported and does not stop the others", async () => {
    sweeps.pages.mockRejectedValue(
      new Error('database is down: relation "pages" detail')
    );
    const out = await runScheduledSweeps();
    expect(sweeps.sessions).toHaveBeenCalledTimes(1);
    expect(sweeps.coupons).toHaveBeenCalledTimes(1);
    expect(out.results.find((r) => r.name === "stuck pages")).toMatchObject({
      count: null,
      error: "failed",
    });
    expect(out.results.find((r) => r.name === "expired sessions")?.error).toBeNull();
    expect(out.results.find((r) => r.name === "expired coupons")?.error).toBeNull();
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
        ["sample books", null],
        ["data deletion", null],
        ["reminder emails", null],
        ["broadcast emails", null],
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
