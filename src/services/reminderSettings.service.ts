import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ValidationError } from "../utils/errors.js";
import type { UpdateReminderSettingsInput } from "../validators/reminder.schema.js";

/** Matches the `@default("singleton")` on ReminderSetting.id in schema.prisma (same idea as SiteSetting). */
const SINGLETON_ID = "singleton";

/**
 * The one settings row. It is created with its defaults the first time anyone reads it (every reminder
 * switched off), so a fresh database needs no seed and the old backend, which never reads this table,
 * is not affected.
 */
export async function getReminderSettings() {
  return prisma.reminderSetting.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
}

const sameList = (a: number[], b: number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Saves the admin's changes. Checks the rules that need the stored values, and sets `effectiveFrom` of a
 * reminder to now whenever it is switched on or its send times change, or the send window changes while
 * it is on. An offset only counts if it became due after that moment (utils/reminderSchedule.ts), which is
 * what stops a switch or an edit from mailing the history. Nothing else here sends or reads any customer.
 */
export async function updateReminderSettings(
  data: UpdateReminderSettingsInput
) {
  const current = await getReminderSettings();
  const now = new Date();

  const next = {
    previewEnabled: data.previewEnabled ?? current.previewEnabled,
    bookEnabled: data.bookEnabled ?? current.bookEnabled,
    reviewEnabled: data.reviewEnabled ?? current.reviewEnabled,
    googleReviewUrl:
      data.googleReviewUrl === undefined
        ? current.googleReviewUrl
        : data.googleReviewUrl,
    dailyBudget: data.dailyBudget ?? current.dailyBudget,
    reminderReserve: data.reminderReserve ?? current.reminderReserve,
    windowStartHour: data.windowStartHour ?? current.windowStartHour,
    windowEndHour: data.windowEndHour ?? current.windowEndHour,
  };

  if (next.reviewEnabled && !next.googleReviewUrl) {
    throw new ValidationError(
      "Add the Google review link before switching on the review reminder."
    );
  }
  const deletionDays =
    data.previewDeletionDays === undefined
      ? current.previewDeletionDays
      : data.previewDeletionDays;
  const previewOffsets =
    data.previewOffsetsHours ?? current.previewOffsetsHours;
  if (
    deletionDays !== null &&
    deletionDays * 24 <= Math.max(...previewOffsets)
  ) {
    // The last reminder would name a deletion date that has already passed when it arrives.
    throw new ValidationError(
      "The deletion days must be longer than the last unfinished-preview send time."
    );
  }
  if (data.reminderCouponCode) {
    // A typo would silently never be shown: refuse a code that does not exist.
    const coupon = await prisma.coupon.findUnique({
      where: { code: data.reminderCouponCode },
      select: { id: true },
    });
    if (!coupon) {
      throw new ValidationError("There is no coupon with this code.");
    }
  }
  if (next.reminderReserve > next.dailyBudget) {
    throw new ValidationError(
      "The reserve for reminders cannot be more than the daily budget."
    );
  }
  if (next.windowStartHour >= next.windowEndHour) {
    throw new ValidationError("The sending window must start before it ends.");
  }

  const windowChanged =
    next.windowStartHour !== current.windowStartHour ||
    next.windowEndHour !== current.windowEndHour;

  const restart = (
    enabledNow: boolean,
    enabledBefore: boolean,
    offsetsNew: number[] | undefined,
    offsetsOld: number[]
  ) =>
    enabledNow &&
    (!enabledBefore ||
      (offsetsNew !== undefined && !sameList(offsetsNew, offsetsOld)) ||
      windowChanged);

  const restartPreview = restart(
    next.previewEnabled,
    current.previewEnabled,
    data.previewOffsetsHours,
    current.previewOffsetsHours
  );
  const restartBook = restart(
    next.bookEnabled,
    current.bookEnabled,
    data.bookOffsetsHours,
    current.bookOffsetsHours
  );
  const restartReview = restart(
    next.reviewEnabled,
    current.reviewEnabled,
    data.reviewOffsetsHours,
    current.reviewOffsetsHours
  );

  const setting = await prisma.reminderSetting.update({
    where: { id: SINGLETON_ID },
    data: {
      ...data,
      ...(restartPreview ? { previewEffectiveFrom: now } : {}),
      ...(restartBook ? { bookEffectiveFrom: now } : {}),
      ...(restartReview ? { reviewEffectiveFrom: now } : {}),
    },
  });

  logger.info(
    {
      updatedFields: Object.keys(data),
      restarted: { restartPreview, restartBook, restartReview },
    },
    "[Reminders] Settings updated"
  );

  return setting;
}
