import { z } from "zod";

export const getBlogUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|webp)$/,
      "Only PNG, JPEG, and WEBP images are allowed"
    ),
});

// Trimmed + lowercased so "AI Art", "ai art" and " ai art " cannot become three
// separate tags (and three near-duplicate tag pages, if those ever get built).
const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(8, "A blog can have at most 8 tags")
  .optional();

// SEO overrides, shared by create and update.
//
// When null/absent the post falls back to its own `title` and `excerpt` at
// render time, so most posts never need these set. Limits sit above Google's
// ~60/~160 display cut-off because the admin panel warns at those but still
// permits saving.
const metaTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120, "Meta title is too long");
const metaDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(320, "Meta description is too long");

export const createBlogSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  excerpt: z.string().trim().min(1).max(300, "Excerpt is too long").optional(),
  body: z.string().min(1, "Body is required"),
  coverImageKey: z.string().min(1).optional(),
  tags: tagsSchema,
  metaTitle: metaTitleSchema.optional(),
  metaDescription: metaDescriptionSchema.optional(),
});

export const updateBlogSchema = z
  .object({
    title: z.string().trim().min(1).max(200, "Title is too long").optional(),
    excerpt: z.string().trim().min(1).max(300, "Excerpt is too long").nullable().optional(),
    body: z.string().min(1).optional(),
    coverImageKey: z.string().min(1).nullable().optional(),
    tags: tagsSchema,
    metaTitle: metaTitleSchema.nullable().optional(),
    metaDescription: metaDescriptionSchema.nullable().optional(),
    // NOTE: `slug` and `isActive` are deliberately absent.
    // slug is frozen after create so shared links never 404.
    // isActive is owned exclusively by PATCH /blogs/:id/status.
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

// Query string, so the value arrives as "true"/"false" text.
// NOT z.coerce.boolean() — that runs Boolean("false"), which is `true`.
export const adminBlogQuerySchema = z.object({
  isActive: z
    .enum(["true", "false"], { message: "isActive must be true or false" })
    .transform((value) => value === "true")
    .optional(),
});
