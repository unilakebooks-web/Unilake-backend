import {
  COUPON_CODE_PATTERN,
  GENERATED_CODE_ALPHABET,
  GENERATED_CODE_LENGTH,
} from "../config/coupon.js";
import { REPORTING_UTC_OFFSET } from "../config/stats.js";

/**
 * Pure helpers for coupon codes and for the dates an admin enters. No I/O, so
 * they are unit-tested directly.
 */

/** Trim and upper-case, so "  festive-25 " and "FESTIVE-25" are the same code. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True when an already-normalized code matches the allowed format. */
export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_PATTERN.test(code);
}

/**
 * Builds a random code from the unambiguous alphabet. `pickIndex(max)` returns
 * an integer in [0, max); the caller passes `crypto.randomInt` in production and
 * a stub in tests.
 */
export function generateCouponCode(
  pickIndex: (max: number) => number,
  length: number = GENERATED_CODE_LENGTH
): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += GENERATED_CODE_ALPHABET[pickIndex(GENERATED_CODE_ALPHABET.length)];
  }
  return code;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * True when "YYYY-MM-DD" is a real calendar date. `new Date("2026-02-30")` does
 * not fail, it silently rolls over to 1 March, so this is checked explicitly.
 */
function isRealCalendarDate(datePart: string): boolean {
  const [year, month, day] = datePart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Turns what the admin entered into the UTC instant stored in the database.
 *
 * - A date only ("2026-12-31") is read in IST. As a start it means 00:00:00.000
 *   IST that day; as an end it means 23:59:59.999 IST that day, so "valid until
 *   31 December" includes all of the 31st.
 * - A full date-time must carry an explicit offset ("...+05:30" or "Z"); one
 *   without is ambiguous and is refused.
 *
 * Returns null for anything that is not a real date (for example 2026-02-30).
 */
export function parseValidityInput(
  input: string,
  edge: "start" | "end"
): Date | null {
  const value = input.trim();

  if (DATE_ONLY.test(value)) {
    if (!isRealCalendarDate(value)) return null;
    const time = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
    const date = new Date(`${value}${time}${REPORTING_UTC_OFFSET}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (DATE_TIME_WITH_OFFSET.test(value)) {
    if (!isRealCalendarDate(value.slice(0, 10))) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}
