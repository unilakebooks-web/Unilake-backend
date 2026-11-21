// Reminder settings (feature 5): the rules the admin form relies on, and the status read. Test branch only.
// The settings row is a singleton, so the original row is restored afterwards.
import "../setup/env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  getReminderSettings,
  updateReminderSettings,
} from "../../src/services/reminderSettings.service.js";
import { getReminderStatus } from "../../src/services/reminder.service.js";
import { updateReminderSettingsSchema } from "../../src/validators/reminder.schema.js";

const REVIEW_URL = "https://g.page/r/example-vitest/review";
let original: Awaited<ReturnType<typeof getReminderSettings>>;

async function reset() {
  await prisma.reminderSetting.update({
    where: { id: "singleton" },
    data: {
      previewEnabled: false,
      bookEnabled: false,
      reviewEnabled: false,
      googleReviewUrl: null,
      dailyBudget: 30,
      reminderReserve: 10,
      windowStartHour: 9,
      windowEndHour: 20,
      previewOffsetsHours: [3, 24, 96],
      bookOffsetsHours: [24, 72, 168],
      reviewOffsetsHours: [168, 336],
      previewDeletionDays: null,
      previewEffectiveFrom: null,
      bookEffectiveFrom: null,
      reviewEffectiveFrom: null,
    },
  });
}

beforeAll(async () => {
  original = await getReminderSettings();
});
beforeEach(reset);
afterAll(async () => {
  if (original) {
    const { id, createdAt, updatedAt, ...rest } = original;
    await prisma.reminderSetting.update({ where: { id }, data: rest });
  }
  await prisma.$disconnect();
});

describe("updateReminderSettings", () => {
  it("switching a reminder on sets its start time; the other kinds stay unset", async () => {
    const before = Date.now();
    const saved = await updateReminderSettings({ previewEnabled: true });
    expect(saved.previewEffectiveFrom!.getTime()).toBeGreaterThanOrEqual(
      before - 1000
    );
    expect(saved.bookEffectiveFrom).toBeNull();
    expect(saved.reviewEffectiveFrom).toBeNull();
  });

  it("saving other fields while it stays on does not restart it", async () => {
    const first = await updateReminderSettings({ previewEnabled: true });
    const second = await updateReminderSettings({ dailyBudget: 40 });
    expect(second.previewEffectiveFrom!.getTime()).toBe(
      first.previewEffectiveFrom!.getTime()
    );
    expect(second.dailyBudget).toBe(40);
  });

  it("changing the send times of an enabled reminder restarts it, resaving the same list does not", async () => {
    const first = await updateReminderSettings({ previewEnabled: true });
    const same = await updateReminderSettings({
      previewOffsetsHours: [3, 24, 96],
    });
    expect(same.previewEffectiveFrom!.getTime()).toBe(
      first.previewEffectiveFrom!.getTime()
    );
    await new Promise((r) => setTimeout(r, 15));
    const changed = await updateReminderSettings({
      previewOffsetsHours: [2, 24],
    });
    expect(changed.previewEffectiveFrom!.getTime()).toBeGreaterThan(
      first.previewEffectiveFrom!.getTime()
    );
  });

  it("changing the times of a reminder that is off does not set a start time", async () => {
    const saved = await updateReminderSettings({ bookOffsetsHours: [12, 48] });
    expect(saved.bookEffectiveFrom).toBeNull();
  });

  it("changing the window restarts the enabled reminders only", async () => {
    await updateReminderSettings({ previewEnabled: true });
    const saved = await updateReminderSettings({ windowStartHour: 10 });
    expect(saved.previewEffectiveFrom).not.toBeNull();
    expect(saved.bookEffectiveFrom).toBeNull();
  });

  it("the review reminder cannot be switched on without a link, and can with one", async () => {
    await expect(
      updateReminderSettings({ reviewEnabled: true })
    ).rejects.toThrow(/Google review link/);
    const saved = await updateReminderSettings({
      reviewEnabled: true,
      googleReviewUrl: REVIEW_URL,
    });
    expect(saved.reviewEnabled).toBe(true);
    expect(saved.reviewEffectiveFrom).not.toBeNull();
  });

  it("removing the link while the review reminder is on is refused", async () => {
    await updateReminderSettings({
      reviewEnabled: true,
      googleReviewUrl: REVIEW_URL,
    });
    await expect(
      updateReminderSettings({ googleReviewUrl: null })
    ).rejects.toThrow(/Google review link/);
  });

  it("the reserve cannot be more than the budget, checked against the stored value too", async () => {
    await expect(
      updateReminderSettings({ dailyBudget: 5, reminderReserve: 6 })
    ).rejects.toThrow(/reserve/);
    // the stored reserve is 10: lowering only the budget below it is refused as well
    await expect(updateReminderSettings({ dailyBudget: 8 })).rejects.toThrow(
      /reserve/
    );
  });

  it("the window must start before it ends, also against the stored value", async () => {
    await expect(
      updateReminderSettings({ windowStartHour: 12, windowEndHour: 12 })
    ).rejects.toThrow(/window/);
    await expect(
      updateReminderSettings({ windowStartHour: 21 })
    ).rejects.toThrow(/window/);
  });

  it("the deletion days must be longer than the last unfinished-preview send time, whichever side is edited", async () => {
    // the default last send time is 96 h = 4 days
    await expect(
      updateReminderSettings({ previewDeletionDays: 4 })
    ).rejects.toThrow(/deletion days/i);
    await expect(
      updateReminderSettings({ previewDeletionDays: 3 })
    ).rejects.toThrow(/deletion days/i);
    const ok = await updateReminderSettings({ previewDeletionDays: 5 });
    expect(ok.previewDeletionDays).toBe(5);
    // lengthening the send times past the stored deletion days is refused too
    await expect(
      updateReminderSettings({ previewOffsetsHours: [3, 24, 144] })
    ).rejects.toThrow(/deletion days/i);
    // and empty (no promise of deletion) is always allowed
    const cleared = await updateReminderSettings({ previewDeletionDays: null });
    expect(cleared.previewDeletionDays).toBeNull();
  });

  it("a coupon code that does not exist is refused, so a typo is never silently ignored", async () => {
    await expect(
      updateReminderSettings({ reminderCouponCode: "NO-SUCH-CODE-XYZ" })
    ).rejects.toThrow(/no coupon/i);
    const code = "VTR-SETTINGS-OK";
    await prisma.coupon.deleteMany({ where: { code } });
    await prisma.coupon.create({
      data: {
        code,
        name: "t",
        discountType: "PERCENT",
        percentOff: "10.00",
        createdById: "t",
        updatedById: "t",
      },
    });
    try {
      const saved = await updateReminderSettings({ reminderCouponCode: code });
      expect(saved.reminderCouponCode).toBe(code);
      const cleared = await updateReminderSettings({
        reminderCouponCode: null,
      });
      expect(cleared.reminderCouponCode).toBeNull();
    } finally {
      await prisma.coupon.deleteMany({ where: { code } });
    }
  });

  it("a refused save changes nothing", async () => {
    await expect(updateReminderSettings({ dailyBudget: 5 })).rejects.toThrow();
    const after = await getReminderSettings();
    expect(after.dailyBudget).toBe(30);
  });
});

describe("updateReminderSettingsSchema", () => {
  const bad = (body: unknown) =>
    updateReminderSettingsSchema.safeParse(body).success;

  it("rejects offsets that are not increasing, too many, too large, or not whole hours", () => {
    expect(bad({ previewOffsetsHours: [24, 3] })).toBe(false);
    expect(bad({ previewOffsetsHours: [1, 2, 3, 4] })).toBe(false);
    expect(bad({ previewOffsetsHours: [145] })).toBe(false);
    expect(bad({ previewOffsetsHours: [1.5] })).toBe(false);
    expect(bad({ previewOffsetsHours: [0] })).toBe(false);
    expect(bad({ previewOffsetsHours: [-5, 3] })).toBe(false);
    expect(bad({ previewOffsetsHours: [24, 24] })).toBe(false);
    expect(bad({ previewDeletionDays: 8 })).toBe(false); // a preview expires after 7 days
    expect(bad({ previewDeletionDays: 7 })).toBe(true);
    expect(bad({ previewOffsetsHours: [] })).toBe(false);
    expect(bad({ previewOffsetsHours: [3, 24, 96] })).toBe(true);
  });

  it("accepts only https Google links without credentials for the review link", () => {
    expect(bad({ googleReviewUrl: REVIEW_URL })).toBe(true);
    expect(bad({ googleReviewUrl: null })).toBe(true);
    expect(bad({ googleReviewUrl: "http://g.page/r/x" })).toBe(false);
    expect(bad({ googleReviewUrl: "https://evil.example.com/x" })).toBe(false);
    expect(bad({ googleReviewUrl: "https://user:pw@g.page/r/x" })).toBe(false);
    expect(bad({ googleReviewUrl: "https://g.page.evil.example/x" })).toBe(
      false
    );
  });
});

describe("getReminderStatus", () => {
  it("returns the budget and zero counts when nothing is enabled", async () => {
    const status = await getReminderStatus(
      new Date("2026-11-10T06:00:00.000Z")
    );
    expect(status.budget.daily).toBe(30);
    expect(status.budget.reserve).toBe(10);
    expect(status.dueNow).toEqual({
      PREVIEW_UNFINISHED: 0,
      BOOK_NOT_SENT: 0,
      REVIEW_REQUEST: 0,
    });
  });
});
