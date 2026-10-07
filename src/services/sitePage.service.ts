import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { SitePageSlug } from "../generated/prisma/enums.js";

/**
 * The canonical list of pages, read straight off the generated Prisma enum
 * rather than written out by hand. Add a value to SitePageSlug in
 * schema.prisma and this module picks it up with no further edits — there is
 * nothing here that can drift out of sync with the database.
 */
const ALL_SLUGS = Object.values(SitePageSlug);

/**
 * Pre-filled titles for a page the admin has not saved yet, so the editor
 * opens with something sensible instead of an empty field. Purely a default —
 * once saved, whatever the admin typed wins.
 */
const DEFAULT_TITLES: Record<SitePageSlug, string> = {
  PRIVACY: "Privacy Policy",
  TERMS: "Terms and Conditions",
  REFUND: "Refund Policy",
};

/**
 * The shape both a real row and an unsaved placeholder conform to.
 *
 * Keeping them identical is the whole point: the admin panel renders three
 * cards without ever asking "does this one exist yet?". `id` being null is the
 * only signal that a page has never been saved, and nothing downstream needs
 * to care.
 */
type SitePageView = {
  id: string | null;
  slug: SitePageSlug;
  title: string;
  body: string;
  isActive: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function buildPlaceholder(slug: SitePageSlug): SitePageView {
  return {
    id: null,
    slug,
    title: DEFAULT_TITLES[slug],
    body: "",
    isActive: false,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Admin list. Always returns exactly one entry per slug, whether or not a row
 * exists — so the Pages screen shows three cards from the very first load and
 * never an empty list.
 *
 * One query, then an in-memory merge. With three rows the Map is overkill on
 * cost but it keeps the merge O(n) and reads the same as the rest of the
 * codebase.
 */
export async function listSitePagesAdmin(): Promise<SitePageView[]> {
  const rows = await prisma.sitePage.findMany();
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  return ALL_SLUGS.map((slug) => bySlug.get(slug) ?? buildPlaceholder(slug));
}

/**
 * Admin read of one page.
 *
 * Deliberately never 404s: the admin has to be able to open a page that has
 * never been saved in order to write it for the first time. An unsaved page
 * comes back as a placeholder, which is exactly what the editor needs.
 */
export async function getSitePageAdmin(
  slug: SitePageSlug
): Promise<SitePageView> {
  const row = await prisma.sitePage.findUnique({ where: { slug } });

  return row ?? buildPlaceholder(slug);
}

/**
 * Public read.
 *
 * "No such row" and "exists but unpublished" return the same 404 — one code
 * path, and it matches getBlogBySlugPublic. The frontend must render a proper
 * "not available yet" state for this, because these links sit in the footer of
 * every page on the site.
 */
export async function getSitePagePublic(slug: SitePageSlug) {
  const page = await prisma.sitePage.findUnique({ where: { slug } });

  if (!page || !page.isActive) {
    throw new NotFoundError("Page not found");
  }

  return page;
}

/**
 * Create-or-update. There is no separate create endpoint — the slug set is
 * fixed, so the first save creates the row and every later save updates it.
 *
 * `isActive` is omitted from `create` so the schema default (false) applies:
 * writing a page for the first time never publishes it. It is omitted from
 * `update` too, so saving an edit to a live page cannot silently unpublish it.
 * Publishing is the status endpoint's job alone.
 */
export async function upsertSitePage(
  slug: SitePageSlug,
  data: { title: string; body: string }
) {
  const page = await prisma.sitePage.upsert({
    where: { slug },
    create: {
      slug,
      title: data.title,
      body: data.body,
    },
    update: {
      title: data.title,
      body: data.body,
    },
  });

  logger.info({ slug, isActive: page.isActive }, "Site page saved");

  return page;
}

/**
 * Publish / unpublish toggle.
 *
 * Refuses on a page that has never been saved rather than creating an empty
 * one — publishing a blank privacy policy is a worse outcome than an error the
 * admin can act on.
 */
export async function toggleSitePageStatus(slug: SitePageSlug) {
  const existing = await prisma.sitePage.findUnique({ where: { slug } });

  if (!existing) {
    throw new ConflictError(
      "Save this page before publishing it — there is nothing to show yet."
    );
  }

  const updated = await prisma.sitePage.update({
    where: { slug },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { slug, isActive: updated.isActive },
    "Site page status toggled"
  );

  return updated;
}
