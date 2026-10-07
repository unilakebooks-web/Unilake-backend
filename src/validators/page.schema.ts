import {z} from "zod"
import {
  MIN_STEPS,
  MAX_STEPS,
  MIN_CFG,
  MAX_CFG
} from "../config/generation.js";
import {
  bubbleGeometryFields,
  refineBubbleBounds,
} from "./bubble.schema.js";


export const createPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  artworkUrl: z.string().min(1).optional(),
  maskUrl: z.string().min(1).optional(),
  hasFace: z.boolean().default(false),
  mirrorFace: z.boolean().default(false),
  faceDirection: z.enum(["front", "three-quarter", "side"]).optional(),
  isPreviewPage: z.boolean().default(false),
  pagePrompt: z.string().min(1).optional(),
  steps: z.number().int().min(MIN_STEPS).max(MAX_STEPS).optional(),
  cfg: z.number().min(MIN_CFG).max(MAX_CFG).optional(),
});

export const getPageArtworkUploadUrlSchema = z.object({
  fileExtension: z.enum(["jpg", "jpeg", "png", "webp"]),
  fileType: z.enum(["artwork", "masks"]),
});

export const updatePageSchema = z.object({
  hasFace: z.boolean().optional(),
  mirrorFace: z.boolean().optional(),
  faceDirection: z.enum(["front", "three-quarter", "side"]).nullable().optional(),
  isPreviewPage: z.boolean().optional(),
  pagePrompt: z.string().min(1, "Page prompt cannot be empty").optional(),
  artworkUrl: z.string().min(1).optional(),
  maskUrl: z.string().min(1).optional(),
  steps: z.number().int().min(MIN_STEPS).max(MAX_STEPS).optional(),
  cfg: z.number().min(MIN_CFG).max(MAX_CFG).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

// Position in the array becomes the new pageNumber: index 0 → page 1.
// IDs, not numbers — the numbers are what's being rewritten, so using them
// as the lookup key would be circular.
/**
 * Body for POST /admin/pages/:pageId/preview-stamp.
 *
 * The bubbles travel in the request rather than being read from the DB because
 * the admin mapper holds unsaved edits in the browser — a preview that rendered
 * the stored rows would show the admin something other than what is on screen,
 * which is the one thing a preview must never do.
 *
 * Geometry and styling reuse bubbleGeometryFields from bubble.schema.ts, so
 * anything this endpoint accepts is exactly what the real create endpoint
 * accepts. `id` is free-form, not a uuid: unsaved bubbles carry a client-made
 * draft id like "new-1738...", and it is passed through purely so the
 * renderer's error messages can name the offending bubble.
 */
export const previewPageStampSchema = z.object({
  childName: z.string().trim().min(1, "A name is required").max(50),
  pronounKey: z.enum(["HE", "SHE", "THEY"]),
  bubbles: z
    .array(
      refineBubbleBounds(
        z.object({
          ...bubbleGeometryFields,
          id: z.string().optional(),
          dialogue: z.string(),
          fontId: z.string().uuid().nullable().optional(),
        })
      )
    )
    // An empty array is valid: it renders the bare artwork, which is a
    // legitimate thing to want to look at.
    .max(100, "Too many bubbles for a single page"),
});

export const reorderPagesSchema = z.object({
  orderedPageIds: z
    .array(z.string().uuid("Each page ID must be a valid UUID"))
    .min(1, "orderedPageIds cannot be empty")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedPageIds cannot contain duplicates",
    }),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type GetPageArtworkUploadUrlInput = z.infer<typeof getPageArtworkUploadUrlSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
export type ReorderPagesInput = z.infer<typeof reorderPagesSchema>;
export type PreviewPageStampInput = z.infer<typeof previewPageStampSchema>;
