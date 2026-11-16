import { redisClient } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import {
  FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
  MAX_FAILED_COUPON_ATTEMPTS,
} from "../config/coupon.js";

/**
 * Stops someone guessing coupon codes: after too many failed attempts in a
 * window, further attempts are refused until the window passes.
 *
 * Counted per customer in Redis. If Redis is unavailable the limiter lets the
 * attempt through and logs it: losing brute-force protection for a moment is
 * better than blocking every customer's checkout, and the coupon's own usage
 * limits never depend on this.
 */

const key = (userId: string) => `coupon:failed-attempts:${userId}`;

/** True when this customer has used up their failed attempts for the window. */
export async function isCouponAttemptLimited(userId: string): Promise<boolean> {
  try {
    const count = Number(await redisClient.get(key(userId)));
    return count >= MAX_FAILED_COUPON_ATTEMPTS;
  } catch (err) {
    logger.warn(
      { err },
      "Coupon attempt limiter unavailable; allowing the attempt"
    );
    return false;
  }
}

/** Counts one failed attempt; the window starts at the first failure. */
export async function recordFailedCouponAttempt(userId: string): Promise<void> {
  try {
    // The key is created with its expiry in one command (NX: only when it does
    // not exist yet), so a crash between two calls can never leave a counter
    // that never expires. The window starts at the first failure.
    await redisClient.set(
      key(userId),
      0,
      "EX",
      FAILED_COUPON_ATTEMPT_WINDOW_SECONDS,
      "NX"
    );
    await redisClient.incr(key(userId));
  } catch (err) {
    logger.warn({ err }, "Could not record a failed coupon attempt");
  }
}
