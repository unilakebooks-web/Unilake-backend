import { z } from "zod";

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
});

