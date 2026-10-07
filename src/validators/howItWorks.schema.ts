import { z } from "zod";

export const howItWorksStepSchema = z.object({
  heading: z.string().trim().min(1, "Step heading is required").max(120, "Step heading is too long"),
  description: z.string().trim().min(1, "Step description is required").max(500, "Step description is too long"),
});

// Single source of truth for the shape stored in HowItWorks.steps (a Json column).
// Prisma types that column as JsonValue and knows nothing about its shape — this is it.
export type HowItWorksStep = z.infer<typeof howItWorksStepSchema>;

// Video and poster accept different MIME types, so this is a discriminated union
// rather than one schema with two optional content-type regexes.
export const getHowItWorksUploadUrlSchema = z.discriminatedUnion("assetType", [
  z.object({
    assetType: z.literal("video"),
    fileName: z.string().min(1, "File name is required"),
    contentType: z
      .string()
      .regex(
        /^video\/(mp4|webm|mov|quicktime)$/,
        "Only MP4, WebM, and MOV videos are allowed"
      ),
  }),
  z.object({
    assetType: z.literal("poster"),
    fileName: z.string().min(1, "File name is required"),
    contentType: z
      .string()
      .regex(
        /^image\/(png|jpeg|jpg|webp)$/,
        "Only PNG, JPEG, and WEBP images are allowed"
      ),
  }),
]);

export const updateHowItWorksSchema = z
  .object({
    // omitted = unchanged, a key = replace (old R2 file deleted), null = clear (old R2 file deleted)
    videoKey: z.string().min(1).nullable().optional(),
    posterKey: z.string().min(1).nullable().optional(),
    steps: z.array(howItWorksStepSchema).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });
