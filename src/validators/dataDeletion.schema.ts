import { z } from "zod";
import { DAILY_MAX_LIMIT } from "../config/dataDeletion.js";

export const deletionGroupSchema = z.enum(["PREVIEWS", "PHOTOS", "BOOKS"]);

/** Switches a group's mode (and optionally its daily maximum). ACTIVE also needs the report the admin read. */
export const setDeletionModeSchema = z
  .object({
    mode: z.enum(["OFF", "REPORT_ONLY", "ACTIVE"]),
    dailyMax: z.number().int().min(1).max(DAILY_MAX_LIMIT).optional(),
    expectedModeChangedAt: z.string().datetime().optional(),
    reportRunId: z.string().uuid().optional(),
    dueCount: z.number().int().min(0).optional(),
    confirmation: z.string().max(40).optional(),
  })
  .strict();

/** Retry a FAILED item, or every FAILED item of a group. */
export const retryDeletionSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    group: deletionGroupSchema.optional(),
  })
  .strict()
  .refine(
    (data) => !!data.itemId !== !!data.group,
    "Give either an item or a group"
  );

export const deletionItemActionSchema = z
  .object({ itemId: z.string().uuid() })
  .strict();

/** Undo ghosts for one item, or for a time range (claimed between the two times). */
export const undoGhostSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (data) =>
      (!!data.itemId && !data.from && !data.to) ||
      (!data.itemId &&
        !!data.from &&
        !!data.to &&
        new Date(data.from) < new Date(data.to)),
    "Give either an item, or a time range with the start before the end"
  );
