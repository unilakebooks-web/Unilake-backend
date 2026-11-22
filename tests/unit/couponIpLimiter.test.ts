import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory stand-in for the three Redis commands the limiter uses. `failNext`
// makes the next command reject, to cover the fail-open path.
const redis = vi.hoisted(() => {
  const store = new Map<string, number>();
  const expiries = new Map<string, number>();
  const state = { failNext: false };
  const check = () => {
    if (state.failNext) {
      state.failNext = false;
      throw new Error("redis down");
    }
  };
  return {
    store,
    expiries,
    state,
    client: {
      get: async (key: string) => {
        check();
        return store.has(key) ? String(store.get(key)) : null;
      },
      set: async (
        key: string,
        value: number,
        _ex: string,
        seconds: number,
        nx: string
      ) => {
        check();
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        expiries.set(key, seconds);
        return "OK";
      },
      incr: async (key: string) => {
        check();
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      },
    },
  };
});

const settings = vi.hoisted(() => ({ couponIpLimitEnabled: true }));

vi.mock("../../src/config/env.js", () => ({ config: settings }));
vi.mock("../../src/lib/redis.js", () => ({ redisClient: redis.client }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isCouponAttemptLimited,
  recordFailedCouponAttempt,
} from "../../src/utils/attemptLimiter.js";
import {
  FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
  MAX_FAILED_COUPON_ATTEMPTS,
  MAX_FAILED_COUPON_ATTEMPTS_PER_IP,
} from "../../src/config/coupon.js";

const fail = async (userId: string, ip: string | undefined, times: number) => {
  for (let i = 0; i < times; i++) await recordFailedCouponAttempt(userId, ip);
};

describe("coupon attempt limiter, per account and per IP", () => {
  beforeEach(() => {
    redis.store.clear();
    redis.expiries.clear();
    redis.state.failNext = false;
    settings.couponIpLimitEnabled = true;
  });

  it("still limits one account at its own limit, with or without an IP", async () => {
    await fail("u1", undefined, MAX_FAILED_COUPON_ATTEMPTS - 1);
    expect(await isCouponAttemptLimited("u1")).toBe(false);
    await fail("u1", undefined, 1);
    expect(await isCouponAttemptLimited("u1")).toBe(true);
    expect(await isCouponAttemptLimited("u1", "1.2.3.4")).toBe(true);
  });

  it("does not limit a fresh account below the per-IP limit", async () => {
    for (let i = 0; i < MAX_FAILED_COUPON_ATTEMPTS_PER_IP - 1; i++) {
      await recordFailedCouponAttempt(`hopper-${i}`, "9.9.9.9");
    }
    expect(await isCouponAttemptLimited("brand-new", "9.9.9.9")).toBe(false);
  });

  it("limits a brand-new account once its IP reached the per-IP limit by hopping accounts", async () => {
    // Each account stays under its own limit (a few failures each), the machine does not.
    for (let i = 0; i < MAX_FAILED_COUPON_ATTEMPTS_PER_IP; i++) {
      await recordFailedCouponAttempt(`hopper-${i % 10}`, "9.9.9.9");
    }
    expect(await isCouponAttemptLimited("brand-new", "9.9.9.9")).toBe(true);
  });

  it("gives the IP counter the same expiry as the account counter", async () => {
    await recordFailedCouponAttempt("u1", "9.9.9.9");
    expect(redis.expiries.get("coupon:failed-attempts-ip:9.9.9.9")).toBe(
      FAILED_COUPON_ATTEMPT_WINDOW_SECONDS
    );
    expect(redis.expiries.get("coupon:failed-attempts:u1")).toBe(
      FAILED_COUPON_ATTEMPT_WINDOW_SECONDS
    );
  });

  it("keeps different IP addresses apart", async () => {
    await fail("a", "9.9.9.9", MAX_FAILED_COUPON_ATTEMPTS_PER_IP);
    expect(await isCouponAttemptLimited("someone-else", "8.8.8.8")).toBe(false);
  });

  it("makes no IP counter when no IP is given", async () => {
    await fail("u1", undefined, 3);
    expect([...redis.store.keys()].some((k) => k.includes("-ip:"))).toBe(false);
  });

  it("lets the attempt through when Redis fails, even with an IP", async () => {
    redis.state.failNext = true;
    expect(await isCouponAttemptLimited("u1", "9.9.9.9")).toBe(false);
  });

  it("does not throw when recording fails", async () => {
    redis.state.failNext = true;
    await expect(
      recordFailedCouponAttempt("u1", "9.9.9.9")
    ).resolves.toBeUndefined();
  });

  it("ignores the IP address completely while the switch is off", async () => {
    settings.couponIpLimitEnabled = false;
    for (let i = 0; i < MAX_FAILED_COUPON_ATTEMPTS_PER_IP; i++) {
      await recordFailedCouponAttempt(`hopper-${i % 10}`, "9.9.9.9");
    }
    expect([...redis.store.keys()].some((k) => k.includes("-ip:"))).toBe(false);
    expect(await isCouponAttemptLimited("brand-new", "9.9.9.9")).toBe(false);
  });
});
