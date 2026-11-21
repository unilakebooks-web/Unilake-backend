// Which send time of a reminder, if any, is due now. Pure: no database, no clock of its own.

import { HOUR_MS } from "../config/reminders.js";

/**
 * An offset is the number of hours after `baseTime` at which one reminder goes out. The rule:
 *  - only offsets already due count; of those, only the LATEST can be sent (an earlier one that was missed
 *    is never sent late, so several overdue offsets give one email, not a burst);
 *  - that offset must have become due after `effectiveFrom` (set when the reminder was switched on or its
 *    times changed) and within `catchUpMs`, so enabling or editing can never mail old customers;
 *  - nothing is sent if an offset at or above it was already sent or claimed for this customer, so editing
 *    the list can neither resend nor send an older offset after a newer one.
 * Returns the offset to send, or null.
 */
export function pickDueOffset(args: {
  offsetsHours: number[];
  baseTime: Date;
  now: Date;
  effectiveFrom: Date | null;
  catchUpMs: number;
  claimedOffsets: number[];
}): number | null {
  const {
    offsetsHours,
    baseTime,
    now,
    effectiveFrom,
    catchUpMs,
    claimedOffsets,
  } = args;
  if (effectiveFrom === null) return null;

  const dueOffsets = offsetsHours.filter(
    (hours) => baseTime.getTime() + hours * HOUR_MS <= now.getTime()
  );
  if (dueOffsets.length === 0) return null;

  const latest = Math.max(...dueOffsets);
  const dueAt = baseTime.getTime() + latest * HOUR_MS;
  const earliestAllowed = Math.max(
    now.getTime() - catchUpMs,
    effectiveFrom.getTime()
  );
  if (dueAt < earliestAllowed) return null;

  if (claimedOffsets.some((claimed) => claimed >= latest)) return null;
  return latest;
}
