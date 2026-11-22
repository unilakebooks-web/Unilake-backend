import { redisClient } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import {
  FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
  MAX_FAILED_COUPON_ATTEMPTS,
  MAX_FAILED_COUPON_ATTEMPTS_PER_IP,
  REDIS_WAIT_MS,
} from "../config/coupon.js";

/**
 * Stops someone guessing coupon codes: after too many failed attempts in a
 * window, further attempts are refused until the window passes.
 *
 * Counted per customer in Redis, and also per IP address (with a higher limit)
 * when the caller's address is known and COUPON_IP_LIMIT is "on". If Redis is
 * unavailable the limiter lets the attempt through and logs it: losing
 * brute-force protection for a moment is better than blocking every customer's
 * checkout, and the coupon's own usage limits never depend on this.
 */

const key = (userId: string) => `coupon:failed-attempts:${userId}`;
const ipKey = (ip: string) => `coupon:failed-attempts-ip:${ip}`;

function withinLimit<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis did not answer in time")),
      REDIS_WAIT_MS
    );
  });
  return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
}

/**
 * True when this customer, or the IP address they come from, has used up the
 * failed attempts for the window.
 */
export async function isCouponAttemptLimited(
  userId: string,
  ip?: string | null
): Promise<boolean> {
  try {
    const count = Number(await withinLimit(redisClient.get(key(userId))));
    if (count >= MAX_FAILED_COUPON_ATTEMPTS) return true;
    if (!ip || !config.couponIpLimitEnabled) return false;
    const ipCount = Number(await withinLimit(redisClient.get(ipKey(ip))));
    return ipCount >= MAX_FAILED_COUPON_ATTEMPTS_PER_IP;
  } catch (err) {
    logger.warn(
      { err },
      "Coupon attempt limiter unavailable; allowing the attempt"
    );
    return false;
  }
}

/** Counts one failed attempt for the customer and, when known, their IP. */
export async function recordFailedCouponAttempt(
  userId: string,
  ip?: string | null
): Promise<void> {
  try {
    // The key is created with its expiry in one command (NX: only when it does
    // not exist yet), so a crash between two calls can never leave a counter
    // that never expires. The window starts at the first failure.
    await withinLimit(
      redisClient.set(
        key(userId),
        0,
        "EX",
        FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
        "NX"
      )
    );
    await withinLimit(redisClient.incr(key(userId)));
    if (ip && config.couponIpLimitEnabled) {
      await withinLimit(
        redisClient.set(
          ipKey(ip),
          0,
          "EX",
          FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
          "NX"
        )
      );
      await withinLimit(redisClient.incr(ipKey(ip)));
    }
  } catch (err) {
    logger.warn({ err }, "Could not record a failed coupon attempt");
  }
}
