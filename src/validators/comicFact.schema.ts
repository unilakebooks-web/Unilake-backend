import { z } from "zod";

/**
 * Rotating "did you know" lines shown while a comic generates.
 *
 * Two independent lists per comic, split by placement exactly as Faq splits
 * HOME from COMIC. Unlike Faq there is deliberately NO reorder schema: facts
 * are shuffled client-side on every visit, so a stored order would be written
 * and never read.
 */
const comicFactPlacementEnum = z.enum(["PRELOADER", "GENERATING"], {
  message: "placement must be PRELOADER or GENERATING",
});

// 200 is a display limit, not a storage one. These are read in a 3-second
// window on a loading screen — anything longer cannot be finished before it
// rotates away. The admin panel shows a counter against the same number.
const factTextSchema = z
  .string()
  .trim()
  .min(1, "Fact text is required")
  .max(200, "Fact text is too long (200 characters max)");

export const createComicFactSchema = z.object({
  placement: comicFactPlacementEnum,
  text: factTextSchema,
});

export const updateComicFactSchema = z
  .object({
    // Editable so a fact added to the wrong list can be moved across without
    // retyping it. There is no sortOrder to recompute on the way, which is why
    // this is a plain field assignment rather than Faq's move-to-bottom dance.
    placement: comicFactPlacementEnum.optional(),
    text: factTextSchema.optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

// Query string, parsed manually in the controller — there is no validateQuery
// middleware in this project.
export const adminComicFactQuerySchema = z.object({
  placement: comicFactPlacementEnum.optional(),
});

export type CreateComicFactInput = z.infer<typeof createComicFactSchema>;
export type UpdateComicFactInput = z.infer<typeof updateComicFactSchema>;
export type AdminComicFactQueryInput = z.infer<typeof adminComicFactQuerySchema>;
