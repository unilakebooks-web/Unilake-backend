import { z } from "zod";
import { altText } from "./seoText.schema.js";

export const getHeroImageUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|webp)$/,
      "Only PNG, JPEG, and WEBP images are allowed"
    ),
});

export const createHeroImageSchema = z.object({
  imageKey: z.string().min(1, "Image key is required"),
  imageAlt: altText,
});

// Alt text only: replacing the picture means a new slide (the upload is converted
// to WebP on create), so the one thing an existing slide needs is its alt.
export const updateHeroImageSchema = z
  .object({
    imageAlt: altText,
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

