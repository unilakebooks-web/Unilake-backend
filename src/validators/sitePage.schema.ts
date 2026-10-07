import { z } from "zod";

/**
 * Validates the `:slug` URL param.
 *
 * Kept in lockstep with the SitePageSlug enum in schema.prisma. Note that
 * CONTACT is deliberately NOT here — contact details are structured fields on
 * SiteSetting, not a rich-text page, and live under the admin's Settings
 * section rather than Pages.
 */
export const sitePageSlugParamSchema = z.enum(["PRIVACY", "TERMS", "REFUND"], {
  message: "Invalid page. Must be PRIVACY, TERMS, or REFUND.",
});

/**
 * Body for PUT /site-pages/:slug.
 *
 * Both fields are required because this is a full replace, not a patch — the
 * admin editor always submits the whole document.
 *
 * NOTE: `isActive` is deliberately absent. It is owned exclusively by
 * PATCH /site-pages/:slug/status, so that saving a draft can never
 * accidentally publish it. Same split as the Blog module.
 *
 * `body` has no max length on purpose — a terms document is legitimately long,
 * and Blog.body is uncapped for the same reason.
 */
export const upsertSitePageSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(200, "Title is too long"),
  body: z.string().min(1, "Body is required"),
});

export type SitePageSlugParam = z.infer<typeof sitePageSlugParamSchema>;
export type UpsertSitePageInput = z.infer<typeof upsertSitePageSchema>;
