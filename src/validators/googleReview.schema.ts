import { z } from "zod";

export const getGoogleReviewUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|webp)$/,
      "Only PNG, JPEG, and WEBP images are allowed"
    ),
});

/**
 * Whole stars only. The column is a plain Int — Prisma cannot express a CHECK
 * constraint — so this is the only thing keeping a 0 or a 7 out of the
 * database. Never write `rating` from outside the service layer.
 */
const ratingSchema = z
  .number({ message: "Rating is required" })
  .int("Rating must be a whole number of stars")
  .min(1, "Rating must be at least 1 star")
  .max(5, "Rating cannot be more than 5 stars");

export const createGoogleReviewSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required"),
  rating: ratingSchema,
  reviewText: z.string().trim().min(1, "Review text is required"),
  imageKey: z.string().min(1, "Image is required"),
});

export const updateGoogleReviewSchema = z
  .object({
    customerName: z.string().trim().min(1).optional(),
    rating: ratingSchema.optional(),
    reviewText: z.string().trim().min(1).optional(),

    // `.optional()` but deliberately NOT `.nullable()`.
    //
    // Every other image field in this codebase (teamMember.imageKey,
    // howItWorks.posterKey) is `.nullable().optional()` so null clears the
    // column. Here imageUrl is NOT NULL, so accepting null would mean taking a
    // payload Postgres is guaranteed to reject. Omitted = keep the current
    // image; a key = replace it. There is no way to remove it.
    imageKey: z.string().min(1).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

export type CreateGoogleReviewInput = z.infer<typeof createGoogleReviewSchema>;
export type UpdateGoogleReviewInput = z.infer<typeof updateGoogleReviewSchema>;
export type GetGoogleReviewUploadUrlInput = z.infer<
  typeof getGoogleReviewUploadUrlSchema
>;
