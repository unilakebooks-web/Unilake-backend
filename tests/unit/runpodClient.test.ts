// RunPod's own states, as our client reads them. A job RunPod reports TIMED_OUT must
// fail at once like FAILED and CANCELLED, so BullMQ retries within seconds; before,
// the client kept polling it for the full ~17 minute cap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/env.js", () => ({
  config: { runpod: { endpointId: "test-endpoint", apiKey: "test-key" } },
}));

import { submitAndAwaitResult } from "../../src/jobs/workers/sd/runpodClient.js";

const PARAMS = { workflow: {}, images: [] } as never;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** fetch answering /run with a job id, then each status in turn (the last one repeats). */
function stubRunpod(statuses: Array<Record<string, unknown>>) {
  let polled = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/run"))
        return json({ id: "job-1", status: "IN_QUEUE" });
      const body = statuses[Math.min(polled, statuses.length - 1)]!;
      polled++;
      return json(body);
    })
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("submitAndAwaitResult and RunPod job states", () => {
  for (const status of ["FAILED", "CANCELLED", "TIMED_OUT"]) {
    it(`${status} fails at once, after a single status check`, async () => {
      const calls = stubRunpod([{ id: "job-1", status, error: "boom" }]);
      await expect(submitAndAwaitResult(PARAMS)).rejects.toMatchObject({
        code: "RUNPOD_JOB_FAILED",
        statusCode: 502,
      });
      expect(calls).toHaveLength(2); // /run, then one /status: no waiting
    });
  }

  it("TIMED_OUT names the state in its message", async () => {
    stubRunpod([{ id: "job-1", status: "TIMED_OUT" }]);
    await expect(submitAndAwaitResult(PARAMS)).rejects.toThrow(/timed_out/);
  });

  it("keeps waiting while the job is IN_QUEUE or IN_PROGRESS, then returns the image", async () => {
    const calls = stubRunpod([
      { id: "job-1", status: "IN_QUEUE" },
      { id: "job-1", status: "IN_PROGRESS" },
      {
        id: "job-1",
        status: "COMPLETED",
        delayTime: 1000,
        executionTime: 2000,
        output: {
          images: [{ data: Buffer.from("png-bytes").toString("base64") }],
        },
      },
    ]);
    const pending = submitAndAwaitResult(PARAMS);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.jobId).toBe("job-1");
    expect(result.imageBuffer.toString()).toBe("png-bytes");
    expect(calls).toHaveLength(4); // /run + three status checks
  });
});
