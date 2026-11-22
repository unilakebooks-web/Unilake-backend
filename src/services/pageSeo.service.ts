import { randomUUID } from "node:crypto";
import {
  deleteFile,
  getKeyFromPublicUrl,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { PageSeoSlug } from "../generated/prisma/enums.js";

const UPLOAD_EXPIRY_SECONDS = 15 * 60;

/**
 * The canonical list of pages, read straight off the generated Prisma enum
 * (same approach as sitePage.service.ts), so a new PageSeoSlug value shows up
 * in the admin list with no further edit.
 */
const ALL_SLUGS = Object.values(PageSeoSlug);

/**
 * The shape both a real row and an unsaved placeholder conform to, so the SEO
 * screen renders one card per page without asking whether it exists yet. `id`
 * being null is the only signal that nothing was saved.
 */
type PageSeoView = {
  id: string | null;
  slug: PageSeoSlug;
  metaTitle: string | null;
  metaDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageUrl: string | null;
  ogImageAlt: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function buildPlaceholder(slug: PageSeoSlug): PageSeoView {
  return {
    id: null,
    slug,
    metaTitle: null,
    metaDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageUrl: null,
    ogImageAlt: null,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Presigned upload URL for a share image. Copy of getBlogUploadUrl: the
 * caller gets the key (sent back on save) and the resolved public URL (to show
 * a preview before saving).
 */
export async function getPageSeoUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `page-seo/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated page SEO image upload URL");

  return { uploadUrl, key, publicUrl: getPublicUrl(key) };
}

/**
 * Admin list. Always exactly one entry per slug, whether or not a row exists.
 */
export async function listPageSeoAdmin(): Promise<PageSeoView[]> {
  const rows = await prisma.pageSeo.findMany();
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  return ALL_SLUGS.map((slug) => bySlug.get(slug) ?? buildPlaceholder(slug));
}

/**
 * Public list: only pages the admin has saved. A page without a row is simply
 * absent, and the frontend keeps the text the page has today.
 */
export async function listPageSeoPublic() {
  const items = await prisma.pageSeo.findMany({
    select: {
      slug: true,
      metaTitle: true,
      metaDescription: true,
      ogTitle: true,
      ogDescription: true,
      ogImageUrl: true,
      ogImageAlt: true,
    },
  });

  return { items };
}

/**
 * Create-or-update. The slug set is fixed, so the first save creates the row.
 *
 * Omitted = unchanged, null = clear (the validator turns "" into null). The
 * share image arrives as an R2 key and is stored as a resolved public URL; a
 * replaced or cleared file is deleted after the write, guarded on old URL !=
 * new URL so re-sending the same key (the admin form resends everything)
 * never deletes the live file. Same rule as updateBlog.
 */
export async function upsertPageSeo(
  slug: PageSeoSlug,
  data: {
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImageKey?: string | null;
    ogImageAlt?: string | null;
  }
) {
  const existing = await prisma.pageSeo.findUnique({ where: { slug } });

  const fields: {
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImageUrl?: string | null;
    ogImageAlt?: string | null;
  } = {};
  const oldR2Keys: string[] = [];

  // `!== undefined`, not truthiness, so an explicit null clears the column.
  if (data.metaTitle !== undefined) fields.metaTitle = data.metaTitle;
  if (data.metaDescription !== undefined)
    fields.metaDescription = data.metaDescription;
  if (data.ogTitle !== undefined) fields.ogTitle = data.ogTitle;
  if (data.ogDescription !== undefined)
    fields.ogDescription = data.ogDescription;
  if (data.ogImageAlt !== undefined) fields.ogImageAlt = data.ogImageAlt;

  if (data.ogImageKey !== undefined) {
    const newUrl =
      data.ogImageKey === null ? null : getPublicUrl(data.ogImageKey);

    fields.ogImageUrl = newUrl;

    if (existing?.ogImageUrl && existing.ogImageUrl !== newUrl) {
      oldR2Keys.push(getKeyFromPublicUrl(existing.ogImageUrl));
    }
  }

  const page = await prisma.pageSeo.upsert({
    where: { slug },
    create: { slug, ...fields },
    update: fields,
  });

  // Best-effort, after the DB write succeeds. A failed delete leaves an
  // orphan file in R2, not a broken row.
  for (const key of oldR2Keys) {
    try {
      await deleteFile("public", key);
      logger.info({ slug, key }, "Old page SEO share image deleted from R2");
    } catch (error) {
      logger.warn(
        { err: error, slug, key },
        "Page SEO share image replaced/cleared but old R2 file cleanup failed"
      );
    }
  }

  logger.info({ slug, updatedFields: Object.keys(fields) }, "Page SEO saved");

  return page;
}
