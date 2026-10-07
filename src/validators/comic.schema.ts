import { z } from "zod";

// ============================================================
// Gender / age group / theme — each a LIST on the comic.
// ============================================================
//
// Listed in display order. Saved lists are sorted into this order, so a comic
// tagged GIRL then BOY is stored (and shown everywhere) as BOY, GIRL.
const GENDER_TAGS = ["BOY", "GIRL", "UNISEX"] as const;
const AGE_GROUPS = ["AGE_0_2", "AGE_3_5", "AGE_6_8", "AGE_9_12"] as const;

/** De-duplicates and sorts a list into the order of `order`. */
const normalizeEnumList =
  <T extends string>(order: readonly T[]) =>
  (values: T[]): T[] =>
    order.filter((value) => values.includes(value));

/** At least one gender; duplicates removed; stored in GENDER_TAGS order. */
const genderTagsField = z
  .array(
    z.enum(GENDER_TAGS, {
      message: "Each gender must be exactly BOY, GIRL, or UNISEX",
    }),
    { message: "Genders must be a list" }
  )
  .min(1, "Pick at least one gender")
  .transform(normalizeEnumList(GENDER_TAGS));

/** At least one age group; duplicates removed; stored youngest first. */
const ageGroupsField = z
  .array(z.enum(AGE_GROUPS, { message: "Invalid age group" }), {
    message: "Age groups must be a list",
  })
  .min(1, "Pick at least one age group")
  .transform(normalizeEnumList(AGE_GROUPS));

/** At least one theme id; duplicates removed. Existence is checked in the service. */
const themeIdsField = z
  .array(z.string().uuid("Invalid theme ID"), {
    message: "Themes must be a list",
  })
  .min(1, "Pick at least one theme")
  .transform((ids) => [...new Set(ids)]);

/**
 * A multi-value query-string filter: `?ageGroup=AGE_3_5,AGE_6_8`.
 *
 * Comma-separated so the frontend sends one parameter per filter; a single
 * value (`?ageGroup=AGE_3_5`) is just a one-item list, so older links still
 * work. A repeated parameter (`?ageGroup=a&ageGroup=b`, which Express parses
 * as an array) is accepted too. Empty input means "no filter" — undefined.
 */
const csvListQuery = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === null) return undefined;
    const parts = (Array.isArray(raw) ? raw : [raw])
      .flatMap((part) => String(part).split(","))
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? [...new Set(parts)] : undefined;
  }, z.array(item).optional());

export const createComicSchema = z
  .object({
    title: z
      .string({ message: "Title is requried" })
      .min(1, "Title cannot be empty")
      .max(255, "Title is too long"),

    genderTags: genderTagsField,

    pageCount: z
      .number({ message: "Page count is required" })
      .int("Page count must be a whole number")
      .positive("Page count must be at least 1"),

    freePreviewPages: z
      .number({ message: "Free preview pages count is required" })
      .int("Free preview pages must be a whole number")
      .nonnegative("Free preview pages cannot be negative"),

    thumbnailKeys: z
      .array(
        z
          .string({ message: "Thumbnail key must be a string" })
          .min(1, "Thumbnail key cannot be empty")
      )
      .min(1, "At least one thumbnail is required")
      .max(10, "Maximum 10 thumbnails per comic"),

    pricing: z
      .array(
        z
          .object({
            countryId: z
              .string()
              .uuid("Invalid country ID format. Must be a valid UUID."),
            coverType: z.enum(["HARDCOVER", "SOFTCOVER"], {
              message: "Cover type must be HARDCOVER or SOFTCOVER.",
            }),
            // Display-only strike-through price. Nullable in the DB purely to
            // tolerate rows created before this field existed — every new write
            // must supply it, which is what this schema enforces.
            mrp: z
              .number()
              .positive("MRP must be a positive number greater than 0."),
            price: z
              .number()
              .positive("Price must be a positive number greater than 0."),
          })
          // Refine on the INNER object, not the array, so the error path points
          // at the offending row instead of the whole pricing payload.
          // `>=` not `>`: a comic sold at full price is legitimate — the UI
          // simply hides the strike-through when the two are equal.
          .refine((rule) => rule.mrp >= rule.price, {
            message: "MRP cannot be lower than the selling price.",
            path: ["mrp"],
          })
      )
      .min(1, "You must provide at least one pricing rule for the comic."),

    loraKey: z.string().min(1).optional(),
    loraStrength: z.number().min(0).max(2).optional(),
    description: z.string().min(1).optional(),
    themeIds: themeIdsField,
    ageGroups: ageGroupsField,
    isBestseller: z.boolean().optional(),
  })
  .refine((data) => data.freePreviewPages < data.pageCount, {
    message:
      "Free preview pages must be strictly less than the total page count.",
    path: ["freePreviewPages"],
  });

export const updateComicPricingSchema = z.object({
  pricing: z
    .array(
      z
        .object({
          countryId: z.string().uuid("Invalid country ID format."),
          coverType: z.enum(["HARDCOVER", "SOFTCOVER"], {
            message: "Cover type must be HARDCOVER or SOFTCOVER.",
          }),
          mrp: z.number().positive("MRP must be positive."),
          price: z.number().positive("Price must be positive."),
        })
        // Same rule as createComicSchema — see the comment there.
        .refine((rule) => rule.mrp >= rule.price, {
          message: "MRP cannot be lower than the selling price.",
          path: ["mrp"],
        })
    )
    .min(1, "You must provide at least one pricing rule."),
});

export const updateComicStatusSchema = z.object({
  status: z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED"], {
    message: "Invalid status. Must be DRAFT, PUBLISHED, or UNPUBLISHED.",
  }),
});

// Each filter takes one or more comma-separated values. Within a filter a
// comic matches if it has ANY of them; across filters it must match ALL.
export const comicFilterQuerySchema = z.object({
  gender: csvListQuery(
    z.enum(GENDER_TAGS, {
      message: "Invalid gender filter. Must be BOY, GIRL, or UNISEX.",
    })
  ),
  ageGroup: csvListQuery(z.enum(AGE_GROUPS, { message: "Invalid age group filter." })),
  themeId: csvListQuery(z.string().uuid("Invalid theme ID")),
  search: z.string().optional(), // Marks it as optional so /api/comics works without it
});

export const updateComicSchema = z
  .object({
    title: z.string().min(1).optional(),
    // Optional, but never empty when sent — an edit cannot clear these.
    genderTags: genderTagsField.optional(),
    pageCount: z.number().int().positive().optional(),
    freePreviewPages: z.number().int().positive().optional(),
    loraStrength: z.number().min(0).max(2).optional(),
    loraKey: z.string().min(1).optional(),
    // Entries may be freshly-uploaded R2 keys or URLs the client is re-sending
    // to keep. The service normalizes both. min(1) is what prevents an admin
    // from removing the final thumbnail.
    thumbnailKeys: z
      .array(z.string().min(1))
      .min(
        1,
        "A comic must have at least one thumbnail — you cannot remove the last one"
      )
      .max(10, "Maximum 10 thumbnails per comic")
      .optional(),
    // Optional promo video shown in the comic-detail carousel.
    //   omitted -> unchanged | key -> replace | null -> remove
    // .nullable() is what makes removal expressible at all; an .optional()-only
    // field can never say "clear this column". Same contract as
    // updateHowItWorksSchema.videoKey.
    videoKey: z.string().min(1).nullable().optional(),
    // SEO overrides. Null clears them, and a cleared field falls back to the
    // comic's own `title` / `description` at render time — so the admin only
    // fills these in when they want search results to read differently from
    // the page itself. Limits sit above Google's ~60/~160 display cut-off for
    // the same reason as in siteSetting.schema.ts.
    metaTitle: z.string().trim().min(1).max(120, "Meta title is too long").nullable().optional(),
    metaDescription: z
      .string()
      .trim()
      .min(1)
      .max(320, "Meta description is too long")
      .nullable()
      .optional(),
    description: z.string().min(1).optional(),
    // Replaces the comic's whole theme set when sent.
    themeIds: themeIdsField.optional(),
    ageGroups: ageGroupsField.optional(),
    isBestseller: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

export const getLoraUploadUrlSchema = z.object({
  fileName: z.string().min(1),
});

export const uploadThumbnailsBatchSchema = z.object({
  files: z
    .array(
      z.object({
        fileName: z.string().min(1, "File name is required"),
        contentType: z
          .string()
          .regex(
            /^image\/(png|jpeg|jpg|webp)$/,
            "Invalid content type. Only PNG, JPEG, and WEBP images are allowed for thumbnails."
          ),
      })
    )
    .min(1, "At least one file is required")
    .max(10, "Maximum 10 thumbnails per request"),
});

// MP4 and WebM only — deliberately NARROWER than the customerReview/howItWorks
// video validators, which also accept mov/quicktime. No browser reliably plays
// video/quicktime in a <video> tag, so accepting it here would store a file that
// renders as a dead slide with no error anywhere — the same shape of bug as the
// WOFF2 fonts the upload validator accepts but the renderer cannot parse.
export const getComicVideoUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^video\/(mp4|webm)$/,
      "Only MP4 and WebM videos are allowed. Convert MOV files before uploading."
    ),
});

// Same multi-value contract as comicFilterQuerySchema.
export const adminComicFilterQuerySchema = z.object({
  gender: csvListQuery(z.enum(GENDER_TAGS, { message: "Invalid gender filter." })),
  ageGroup: csvListQuery(z.enum(AGE_GROUPS, { message: "Invalid age group filter." })),
  themeId: csvListQuery(z.string().uuid("Invalid theme ID")),
  search: z.string().optional(),
});

export type CreateComicInput = z.infer<typeof createComicSchema>;
export type UpdateComicPricingInput = z.infer<typeof updateComicPricingSchema>;
export type UpdateComicStatusInput = z.infer<typeof updateComicStatusSchema>;
export type ComicFilterQueryInput = z.infer<typeof comicFilterQuerySchema>;
export type UpdateComicInput = z.infer<typeof updateComicSchema>;
export type GetLoraUploadUrlInput = z.infer<typeof getLoraUploadUrlSchema>;
export type AdminComicFilterQueryInput = z.infer<
  typeof adminComicFilterQuerySchema
>;
export type UploadThumbnailsBatchInput = z.infer<
  typeof uploadThumbnailsBatchSchema
>;
export type GetComicVideoUploadUrlInput = z.infer<
  typeof getComicVideoUploadUrlSchema
>;

// export const updateComicSchema = createComicSchema.partial();
// export type UpdateComicInput = z.infer<typeof updateComicSchema>;
