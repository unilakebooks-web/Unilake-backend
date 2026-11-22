import { z } from "zod";
import { PageSeoSlug } from "../generated/prisma/enums.js";
import { seoText } from "./seoText.schema.js";

const PAGE_SEO_SLUGS = Object.values(PageSeoSlug);

/**
 * Validates the `:slug` URL param.
 *
 * The list is read off the generated Prisma enum, so a page added to
 * PageSeoSlug in schema.prisma is accepted here with no second edit and the
 * two cannot drift (SitePage spells its list out by hand; this does not need to).
 */
export const pageSeoSlugParamSchema = z.enum(PageSeoSlug, {
  message: `Invalid page. Must be one of: ${PAGE_SEO_SLUGS.join(", ")}.`,
});

// Copy of getBlogUploadUrlSchema: same file types, same rules.
export const getPageSeoUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|webp)$/,
      "Only PNG, JPEG, and WEBP images are allowed"
    ),
});

// The folder POST /page-seo/upload-url writes to. Checked because the key is
// later used to delete the replaced file: it must never name some other file.
export const PAGE_SEO_IMAGE_KEY_PREFIX = "page-seo/";

/**
 * Body for PUT /page-seo/:slug.
 *
 * Every field is optional: omitted leaves the stored value alone, null or ""
 * clears it, and a page with nothing saved falls back to the text it has
 * today. The limits match the existing meta fields (title 120, description
 * 320), above what search engines display so the admin's counter can warn
 * without a hard failure.
 *
 * `ogImageKey` is an R2 key from /page-seo/upload-url; the service stores the
 * resolved public URL, exactly like a blog's coverImageKey.
 */
export const upsertPageSeoSchema = z.object({
  metaTitle: seoText(120, "Meta title"),
  metaDescription: seoText(320, "Meta description"),
  ogTitle: seoText(120, "Share title"),
  ogDescription: seoText(320, "Share description"),
  ogImageKey: seoText(500, "Share image key").refine(
    (key) =>
      key == null ||
      (key.startsWith(PAGE_SEO_IMAGE_KEY_PREFIX) && !key.includes("..")),
    { message: "Share image key is not valid. Upload the image again." }
  ),
  ogImageAlt: seoText(200, "Alt text"),
});

export type PageSeoSlugParam = z.infer<typeof pageSeoSlugParamSchema>;
export type UpsertPageSeoInput = z.infer<typeof upsertPageSeoSchema>;
