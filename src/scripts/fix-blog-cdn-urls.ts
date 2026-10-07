/**
 * One-off repair: rewrite broken `/cdn/<key>` image sources in stored HTML.
 *
 * WHY THIS EXISTS
 * The admin editor used to insert in-body images with a relative src of
 * `/cdn/<key>`, pointing at a Next.js rewrite that was never actually
 * configured. Every such image has therefore 404'd for every visitor since the
 * feature shipped. The editor now embeds the absolute R2 URL returned by
 * `getBlogUploadUrl`, but posts saved before that fix still carry the dead path
 * in their body HTML — no code change reaches them, so this does.
 *
 * WHAT IT DOES
 * Rewrites `/cdn/<key>` to `<R2_PUBLIC_URL_BASE>/<key>` in `blogs.body`, and
 * scans `site_pages.body` as well. Site pages pass allowImages={false} to the
 * editor, so a hit there is not expected — but that flag was added later, so
 * the scan is cheap insurance rather than dead code.
 *
 * SAFETY
 * Dry-run by default: prints what it would change and writes nothing. Pass
 * --commit to persist. Idempotent — once a row is fixed it contains no `/cdn/`,
 * so a second run is a no-op.
 *
 * USAGE
 *   npx tsx src/scripts/fix-blog-cdn-urls.ts            # dry run
 *   npx tsx src/scripts/fix-blog-cdn-urls.ts --commit   # write
 */

import { config } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

const COMMIT = process.argv.includes("--commit");

/**
 * Matches a quoted `/cdn/...` attribute value, capturing the quote style so it
 * can be reproduced exactly. Anchored on the quote at both ends so it cannot
 * run past the attribute and swallow the rest of the tag.
 */
const CDN_SRC_PATTERN = /(["'])\/cdn\/([^"']+)\1/g;

const PUBLIC_BASE = config.r2.publicUrlBase.replace(/\/$/, "");

interface RewriteResult {
  body: string;
  replacements: number;
}

function rewriteCdnUrls(body: string): RewriteResult {
  let replacements = 0;

  const rewritten = body.replace(CDN_SRC_PATTERN, (_match, quote, key) => {
    replacements++;
    return `${quote}${PUBLIC_BASE}/${key}${quote}`;
  });

  return { body: rewritten, replacements };
}

async function fixBlogs(): Promise<number> {
  const blogs = await prisma.blog.findMany({
    where: { body: { contains: "/cdn/" } },
    select: { id: true, slug: true, body: true },
  });

  if (blogs.length === 0) {
    console.log("blogs:      nothing to fix");
    return 0;
  }

  let totalReplacements = 0;

  for (const blog of blogs) {
    const { body, replacements } = rewriteCdnUrls(blog.body);
    totalReplacements += replacements;

    console.log(
      `blogs:      ${blog.slug} — ${replacements} image src(s)`
    );

    if (COMMIT) {
      await prisma.blog.update({ where: { id: blog.id }, data: { body } });
    }
  }

  return totalReplacements;
}

async function fixSitePages(): Promise<number> {
  const pages = await prisma.sitePage.findMany({
    where: { body: { contains: "/cdn/" } },
    select: { id: true, slug: true, body: true },
  });

  if (pages.length === 0) {
    console.log("site_pages: nothing to fix (expected)");
    return 0;
  }

  let totalReplacements = 0;

  for (const page of pages) {
    const { body, replacements } = rewriteCdnUrls(page.body);
    totalReplacements += replacements;

    console.log(
      `site_pages: ${page.slug} — ${replacements} image src(s) [UNEXPECTED, but handled]`
    );

    if (COMMIT) {
      await prisma.sitePage.update({ where: { id: page.id }, data: { body } });
    }
  }

  return totalReplacements;
}

async function main() {
  console.log(
    COMMIT
      ? "MODE: COMMIT — changes WILL be written\n"
      : "MODE: DRY RUN — nothing will be written (pass --commit to apply)\n"
  );
  console.log(`Rewriting /cdn/<key>  ->  ${PUBLIC_BASE}/<key>\n`);

  const blogCount = await fixBlogs();
  const sitePageCount = await fixSitePages();
  const total = blogCount + sitePageCount;

  console.log(
    `\n${total} image src(s) ${COMMIT ? "rewritten" : "would be rewritten"}.`
  );

  if (total > 0 && !COMMIT) {
    console.log("Re-run with --commit to apply.");
  }
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
