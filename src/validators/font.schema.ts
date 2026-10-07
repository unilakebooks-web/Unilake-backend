import {z} from "zod";

export const getFontUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  fileExtension: z.enum(["ttf", "otf", "woff", "woff2"]),
});

export const createFontSchema = z.object({
  name: z.string().min(1),
  fontKey: z.string().min(1),
});

export const updateFontSchema = z.object({
  name: z.string().min(1).optional(),
  fontKey: z.string().min(1).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

export type GetFontUploadUrlInput = z.infer<typeof getFontUploadUrlSchema>;
export type CreateFontInput = z.infer<typeof createFontSchema>;
export type UpdateFontInput = z.infer<typeof updateFontSchema>;