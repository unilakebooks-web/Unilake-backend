import { PHONE_KEY_DIGITS } from "../config/coupon.js";

const FILLER_KEYS = ["1234567890", "0123456789", "9876543210"];

/**
 * Pure helper that turns a delivery phone number into the key two orders are
 * compared by, so "+91 99561 22575", "099561-22575" and "9956122575" are the
 * same customer. No I/O, so it is unit-tested directly.
 *
 * The key is the last PHONE_KEY_DIGITS digits. A number with fewer digits is too
 * short to tell customers apart, so it has no key and is never compared. The same
 * goes for obvious filler numbers (all one digit, or a run like 1234567890),
 * which many unrelated customers type.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < PHONE_KEY_DIGITS) return null;
  const key = digits.slice(-PHONE_KEY_DIGITS);
  if (/^(\d)\1+$/.test(key) || FILLER_KEYS.includes(key)) return null;
  return key;
}
