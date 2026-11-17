import { describe, expect, it, vi } from "vitest";

// Redis down: the client queues commands and never answers. The limiter must
// give up quickly and let the attempt through instead of hanging the request.
vi.mock("../../src/lib/redis.js", () => ({
  redisClient: {
    get: () => new Promise(() => {}),
    set: () => new Promise(() => {}),
    incr: () => new Promise(() => {}),
  },
}));

import {
  isCouponAttemptLimited,
  recordFailedCouponAttempt,
} from "../../src/utils/attemptLimiter.js";

describe("attempt limiter when Redis does not answer", () => {
  it("lets the attempt through instead of waiting", async () => {
    const started = Date.now();
    expect(await isCouponAttemptLimited("user-1")).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not hang when recording a failed attempt", async () => {
    const started = Date.now();
    await recordFailedCouponAttempt("user-1");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
