import { describe, it, expect } from "vitest";
import { pickDueOffset } from "../../src/utils/reminderSchedule.js";
import {
  istDayStart,
  istHour,
  isInsideSendWindow,
} from "../../src/utils/reminderTime.js";
import { CATCH_UP_WINDOW_MS } from "../../src/config/reminders.js";

const H = 60 * 60 * 1000;
const base = new Date("2026-11-10T04:00:00.000Z"); // 09:30 IST
const at = (hoursAfterBase: number) =>
  new Date(base.getTime() + hoursAfterBase * H);
const enabledBeforeBase = new Date(base.getTime() - 100 * H);

function pick(
  over: Partial<Parameters<typeof pickDueOffset>[0]> & { nowH: number }
) {
  const { nowH, ...rest } = over;
  return pickDueOffset({
    offsetsHours: [3, 24, 96],
    baseTime: base,
    now: at(nowH),
    effectiveFrom: enabledBeforeBase,
    catchUpMs: CATCH_UP_WINDOW_MS,
    claimedOffsets: [],
    ...rest,
  });
}

describe("pickDueOffset", () => {
  it("returns nothing before the first offset is due, and the offset the moment it is", () => {
    expect(pick({ nowH: 2.99 })).toBeNull();
    expect(pick({ nowH: 3 })).toBe(3);
  });

  it("sends the latest due offset only, never the older ones as well", () => {
    expect(pick({ nowH: 30 })).toBe(24); // 3 h is overdue too, but only 24 h goes
    expect(pick({ nowH: 30, claimedOffsets: [24] })).toBeNull();
  });

  it("does not send an older offset after a newer one was claimed", () => {
    expect(pick({ nowH: 30, claimedOffsets: [96] })).toBeNull();
    expect(pick({ nowH: 4, claimedOffsets: [24] })).toBeNull();
  });

  it("sends the next offset after the previous one was claimed", () => {
    expect(pick({ nowH: 25, claimedOffsets: [3] })).toBe(24);
  });

  it("stops sending an offset once it became due more than the catch-up window ago (exact boundary)", () => {
    // 24 h offset is due at 24 h after base; the window is 24 h.
    expect(pick({ nowH: 24 + 24 })).toBe(24); // exactly 24 h after it became due: still allowed
    expect(pick({ nowH: 24 + 24 + 0.01 })).toBeNull(); // a moment later: dropped
  });

  it("never mails history when a reminder is switched on: offsets due before effectiveFrom do not count", () => {
    const switchedOnAt = at(500);
    // a customer made 500 hours ago: every offset is long overdue and before the switch
    expect(pick({ nowH: 500.5, effectiveFrom: switchedOnAt })).toBeNull();
  });

  it("switching on does count an offset that falls due after the switch", () => {
    const switchedOnAt = at(10);
    expect(pick({ nowH: 24, effectiveFrom: switchedOnAt })).toBe(24);
    // the 3 h offset fell due before the switch, so it never counts
    expect(
      pick({ nowH: 12, effectiveFrom: switchedOnAt, claimedOffsets: [] })
    ).toBeNull();
  });

  it("lowering an offset does not flood: a changed list restarts from effectiveFrom", () => {
    // 20 h after base the admin changes the list to [1]; it was due at 1 h, before the change
    expect(
      pick({ nowH: 20.5, offsetsHours: [1], effectiveFrom: at(20) })
    ).toBeNull();
  });

  it("a reminder that has not been given an effectiveFrom sends nothing", () => {
    expect(pick({ nowH: 30, effectiveFrom: null })).toBeNull();
  });

  it("an empty offset list sends nothing", () => {
    expect(pick({ nowH: 30, offsetsHours: [] })).toBeNull();
  });

  it("offsets keyed by hours: an edited list keeps remembering what was sent", () => {
    // 96 was sent; the admin replaced [3,24,96] with [48,72,96]: 48 and 72 are older than 96, never sent
    expect(
      pick({ nowH: 120, offsetsHours: [48, 72, 96], claimedOffsets: [96] })
    ).toBeNull();
  });
});

describe("India time helpers", () => {
  it("reads the hour in IST", () => {
    expect(istHour(new Date("2026-11-10T03:29:59.000Z"))).toBe(8);
    expect(istHour(new Date("2026-11-10T03:30:00.000Z"))).toBe(9);
    expect(istHour(new Date("2026-11-10T14:29:59.000Z"))).toBe(19);
    expect(istHour(new Date("2026-11-10T14:30:00.000Z"))).toBe(20);
  });

  it("the send window is start inclusive and end exclusive", () => {
    const win = (iso: string) => isInsideSendWindow(new Date(iso), 9, 20);
    expect(win("2026-11-10T03:29:59.000Z")).toBe(false); // 08:59:59
    expect(win("2026-11-10T03:30:00.000Z")).toBe(true); // 09:00
    expect(win("2026-11-10T14:29:59.000Z")).toBe(true); // 19:59:59
    expect(win("2026-11-10T14:30:00.000Z")).toBe(false); // 20:00
  });

  it("the budget day starts at IST midnight, which is 18:30 UTC the evening before", () => {
    expect(
      istDayStart(new Date("2026-12-31T18:29:59.000Z")).toISOString()
    ).toBe("2026-12-30T18:30:00.000Z");
    expect(
      istDayStart(new Date("2026-12-31T18:30:00.000Z")).toISOString()
    ).toBe("2026-12-31T18:30:00.000Z"); // 1 January in India: a new day, a new budget
    expect(
      istDayStart(new Date("2026-12-31T23:00:00.000Z")).toISOString()
    ).toBe("2026-12-31T18:30:00.000Z");
  });
});
