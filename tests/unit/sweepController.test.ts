import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  config: { scheduledSweepSecret: "" },
  run: vi.fn(),
}));
vi.mock("../../src/config/env.js", () => ({ config: holder.config }));
vi.mock("../../src/services/scheduledSweeps.service.js", () => ({
  runScheduledSweeps: holder.run,
}));

import { runSweepsHandler } from "../../src/controllers/sweep.controller.js";

function call(headerValue?: string) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const req = {
    header: (name: string) =>
      name.toLowerCase() === "x-sweep-secret" ? headerValue : undefined,
  };
  const done = runSweepsHandler(req as never, { status } as never, next);
  return { done, status, json, next };
}

beforeEach(() => {
  holder.config.scheduledSweepSecret = "";
  holder.run.mockReset().mockResolvedValue({ skipped: false, results: [] });
});

describe("POST /api/internal/sweeps handler", () => {
  it("answers 404 and runs nothing while no secret is configured, even with a header", async () => {
    const c = call("anything");
    await c.done;
    expect(c.next).toHaveBeenCalledTimes(1);
    expect(
      (c.next.mock.calls[0]?.[0] as { statusCode: number }).statusCode
    ).toBe(404);
    expect(holder.run).not.toHaveBeenCalled();
  });

  it("answers 401 and runs nothing for a missing or wrong secret", async () => {
    holder.config.scheduledSweepSecret = "right-secret";
    for (const header of [undefined, "", "wrong-secret"]) {
      const c = call(header);
      await c.done;
      expect(
        (c.next.mock.calls[0]?.[0] as { statusCode: number }).statusCode
      ).toBe(401);
    }
    expect(holder.run).not.toHaveBeenCalled();
  });

  it("runs the sweeps and answers 200 in the usual envelope for the right secret", async () => {
    holder.config.scheduledSweepSecret = "right-secret";
    holder.run.mockResolvedValue({
      skipped: false,
      results: [{ name: "stuck pages", count: 1, ms: 12, error: null }],
    });
    const c = call("right-secret");
    await c.done;
    expect(c.next).not.toHaveBeenCalled();
    expect(holder.run).toHaveBeenCalledTimes(1);
    expect(c.status).toHaveBeenCalledWith(200);
    expect(c.json).toHaveBeenCalledWith({
      success: true,
      data: {
        skipped: false,
        results: [{ name: "stuck pages", count: 1, ms: 12, error: null }],
      },
    });
  });
});
