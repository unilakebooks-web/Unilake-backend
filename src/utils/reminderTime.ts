// Time rules for the reminder emails. India observes no daylight saving and has held UTC+05:30 since 1945,
// so a fixed offset is exact (the same reasoning as REPORTING_UTC_OFFSET in config/stats.ts).
// Every function takes `now` so a test never has to wait for the clock.

import { DAY_MS } from "../config/reminders.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The hour of the day (0 to 23) in India at this instant. */
export function istHour(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** The instant at which the current Indian day began: the start of the daily email budget. */
export function istDayStart(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  return new Date(shifted - (shifted % DAY_MS) - IST_OFFSET_MS);
}

/** True when it is inside the daily sending window in India (start inclusive, end exclusive). */
export function isInsideSendWindow(
  now: Date,
  startHour: number,
  endHour: number
): boolean {
  const hour = istHour(now);
  return hour >= startHour && hour < endHour;
}
