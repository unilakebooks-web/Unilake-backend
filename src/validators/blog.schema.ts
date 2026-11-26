import { z } from "zod";
import { altText, seoText } from "./seoText.schema.js";
import { optionalWebUrl } from "./siteSetting.schema.js";

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

// Share preview overrides and the books shown at the end of the post.
// ogImageKey is an R2 key, resolved to ogImageUrl like coverImageKey. Featured
// books: at most 6, each once, the array order is the display order; whether
// the ids exist is checked by the service.
const ogTitleSchema = seoText(120, "Share title");
const ogDescriptionSchema = seoText(320, "Share description");
// The folder is checked because the key is later used to delete the replaced
// file: it must never name some other file (a cover). Same rule as the comic's.
export const BLOG_OG_IMAGE_KEY_PREFIX = "blogs/";
const ogImageKeySchema = seoText(500, "Share image key").refine(
  (key) =>
    key == null ||
    (key.startsWith(BLOG_OG_IMAGE_KEY_PREFIX) && !key.includes("..")),
  { message: "Share image key is not valid. Upload the image again." }
);
// The post's own author, for a guest post. A blank name stores null and the post
// shows the site-wide author from the settings instead. The links are rendered as
// href on the post, so only http:// or https:// addresses are accepted.
const authorNameSchema = seoText(100, "Author name");
const authorInstagramUrlSchema = optionalWebUrl("Author Instagram URL");
const authorLinkedinUrlSchema = optionalWebUrl("Author LinkedIn URL");

const featuredComicIdsSchema = z
  .array(z.string().uuid("Each featured comic must be a valid id"))
  .max(6, "A blog can feature at most 6 comics")
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "A comic can only be featured once",
  })
  .optional();

export const createBlogSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title is too long"),
  excerpt: z.string().trim().min(1).max(300, "Excerpt is too long").optional(),
  body: z.string().min(1, "Body is required"),
  coverImageKey: z.string().min(1).optional(),
  tags: tagsSchema,
  metaTitle: metaTitleSchema.optional(),
  metaDescription: metaDescriptionSchema.optional(),
  ogTitle: ogTitleSchema,
  ogDescription: ogDescriptionSchema,
  ogImageKey: ogImageKeySchema,
  coverImageAlt: altText,
  featuredComicIds: featuredComicIdsSchema,
  authorName: authorNameSchema,
  authorInstagramUrl: authorInstagramUrlSchema,
  authorLinkedinUrl: authorLinkedinUrlSchema,
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
    ogTitle: ogTitleSchema,
    ogDescription: ogDescriptionSchema,
    ogImageKey: ogImageKeySchema,
    coverImageAlt: altText,
    featuredComicIds: featuredComicIdsSchema,
    authorName: authorNameSchema,
    authorInstagramUrl: authorInstagramUrlSchema,
    authorLinkedinUrl: authorLinkedinUrlSchema,
    // NOTE: `slug` and `isActive` are deliberately absent.
    // slug is frozen after create so shared links never 404.
    // isActive is owned exclusively by PATCH /blogs/:id/status.
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

// Query string, so the value arrives as "true"/"false" text.
// NOT z.coerce.boolean() - that runs Boolean("false"), which is `true`.
export const adminBlogQuerySchema = z.object({
  isActive: z
    .enum(["true", "false"], { message: "isActive must be true or false" })
    .transform((value) => value === "true")
    .optional(),
});
