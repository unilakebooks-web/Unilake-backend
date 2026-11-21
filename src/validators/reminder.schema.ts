import { z } from "zod";
import {
  MAX_DAILY_BUDGET,
  MAX_OFFSET_HOURS,
  MAX_PER_RUN_LIMIT,
  WINDOW_END_MAX_HOUR,
  WINDOW_START_MAX_HOUR,
  MAX_PREVIEW_DELETION_DAYS,
  MAX_REMINDER_OFFSETS,
} from "../config/reminders.js";
import { isValidCouponCode, normalizeCouponCode } from "../utils/couponCode.js";

/**
 * Hosts a review link may point at. The link goes into an email under our own name, so an arbitrary host
 * would let anyone with admin access send customers anywhere. These are the hosts Google serves review
 * links from (search.google.com and g.page for "write a review", short links on goo.gl); the exact forms
 * were not checked against a live business profile.
 */
function isGoogleReviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "g.page" ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "goo.gl" ||
    host === "maps.app.goo.gl"
  );
}

const googleReviewUrlSchema = z
  .string()
  .trim()
  .url("Review link must be a valid URL")
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        isGoogleReviewHost(parsed.hostname)
      );
    },
    {
      message:
        "Review link must be an https:// Google link (use the 'write a review' link from your Google Business Profile).",
    }
  )
  .nullable()
  .optional();

const offsetsSchema = (kind: keyof typeof MAX_OFFSET_HOURS, label: string) =>
  z
    .array(
      z
        .number()
        .int(`${label} times must be whole hours`)
        .min(1, `${label} times must be at least 1 hour`)
        .max(
          MAX_OFFSET_HOURS[kind],
          `${label} times can be at most ${MAX_OFFSET_HOURS[kind]} hours`
        )
    )
    .min(1, `${label} needs at least one send time`)
    .max(
      MAX_REMINDER_OFFSETS,
      `${label} can have at most ${MAX_REMINDER_OFFSETS} send times`
    )
    .refine((hours) => hours.every((h, i) => i === 0 || h > hours[i - 1]!), {
      message: `${label} send times must be in increasing order, each later than the one before`,
    })
    .optional();

/**
 * Body for PATCH /reminders/settings. Every field is optional (omitted = unchanged, null clears the
 * nullable ones), the same convention as updateSiteSettingSchema. Rules that depend on the stored values
 * (the review reminder needs a link, the reserve cannot exceed the budget, the window must be one range)
 * are checked in the service against the merged result.
 */
export const updateReminderSettingsSchema = z
  .object({
    previewEnabled: z.boolean().optional(),
    previewOffsetsHours: offsetsSchema(
      "PREVIEW_UNFINISHED",
      "Unfinished preview reminder"
    ),
    bookEnabled: z.boolean().optional(),
    bookOffsetsHours: offsetsSchema("BOOK_NOT_SENT", "Book-not-sent reminder"),
    reviewEnabled: z.boolean().optional(),
    reviewOffsetsHours: offsetsSchema("REVIEW_REQUEST", "Review reminder"),

    googleReviewUrl: googleReviewUrlSchema,
    reminderCouponCode: z
      .string()
      .trim()
      .transform(normalizeCouponCode)
      .refine(isValidCouponCode, {
        message:
          "Coupon code must be 4 to 32 characters: A to Z, 0 to 9 and hyphens",
      })
      .nullable()
      .optional(),
    // Kept only for compatibility: accepted and stored, but no longer used (the last reminder takes its date from the
    // preview's own expiry while automatic deletion is switched on: feature 6, D-087).
    previewDeletionDays: z
      .number()
      .int("Deletion days must be a whole number")
      .min(1, "Deletion days must be at least 1")
      .max(
        MAX_PREVIEW_DELETION_DAYS,
        `Deletion days can be at most ${MAX_PREVIEW_DELETION_DAYS}`
      )
      .nullable()
      .optional(),

    dailyBudget: z
      .number()
      .int("Daily budget must be a whole number")
      .min(1, "Daily budget must be at least 1")
      .max(MAX_DAILY_BUDGET, `Daily budget can be at most ${MAX_DAILY_BUDGET}`)
      .optional(),
    reminderReserve: z
      .number()
      .int("Reserve must be a whole number")
      .min(0, "Reserve cannot be negative")
      .max(MAX_DAILY_BUDGET, `Reserve can be at most ${MAX_DAILY_BUDGET}`)
      .optional(),
    perRunLimit: z
      .number()
      .int("Per-run limit must be a whole number")
      .min(1, "Per-run limit must be at least 1")
      .max(
        MAX_PER_RUN_LIMIT,
        `Per-run limit can be at most ${MAX_PER_RUN_LIMIT}`
      )
      .optional(),

    windowStartHour: z
      .number()
      .int("Start hour must be a whole number")
      .min(0, `Start hour must be 0 to ${WINDOW_START_MAX_HOUR}`)
      .max(
        WINDOW_START_MAX_HOUR,
        `Start hour must be 0 to ${WINDOW_START_MAX_HOUR}`
      )
      .optional(),
    windowEndHour: z
      .number()
      .int("End hour must be a whole number")
      .min(1, `End hour must be 1 to ${WINDOW_END_MAX_HOUR}`)
      .max(WINDOW_END_MAX_HOUR, `End hour must be 1 to ${WINDOW_END_MAX_HOUR}`)
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Send at least one field to change",
  });

export type UpdateReminderSettingsInput = z.infer<
  typeof updateReminderSettingsSchema
>;
