/**
 * One-off: shrink the comic cover thumbnails and hero slides that were stored
 * before uploads were optimised.
 *
 * WHY THIS EXISTS
 * New uploads are turned into a web-sized WebP when they are saved
 * (imageUpload.service.ts). Files uploaded earlier are still the raw originals,
 * some of them 10 MB PNGs, and nothing else reaches them.
 *
 * WHAT IT DOES
 * For every comic thumbnail and hero slide whose stored URL points at a file in
 * this bucket that has not been optimised: reads it, makes the WebP, writes it
 * under a new key and points the row at it. Files that are already optimised, or
 * whose URL is not in this bucket, are skipped. Page artwork and masks are never
 * touched: those are the print masters.
 *
 * SAFETY
 *  - Dry run by default: reads every file and reports what it would do and how
 *    many bytes it would save, and writes nothing. Pass --commit to apply.
 *  - Nothing is deleted by default. The old files stay in R2, so a bad result is
 *    undone by pointing the row back. Adding --delete-old to the same --commit run
 *    also removes the old files of the rows rewritten in that run, which cannot be
 *    undone: use it only after a dry run has been read. A file that a comic or
 *    slide still uses is never removed. Order pages, emails already sent and
 *    browser caches can still hold the old addresses, so keeping the old files
 *    for a while is the safe choice (they cost little).
 *  - A row is rewritten only if it still holds the value that was read (a change
 *    made meanwhile makes that row be skipped, and is reported).
 *  - Idempotent: a second run finds nothing left to do.
 *
 * USAGE (check DATABASE_URL and the R2 variables first: they decide which data this touches)
 *   npx tsx src/scripts/optimise-existing-images.ts                          # dry run
 *   npx tsx src/scripts/optimise-existing-images.ts --commit                 # write
 *   npx tsx src/scripts/optimise-existing-images.ts --commit --delete-old    # write and remove the old files
 */

import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildThumbnailImage } from "../lib/image.js";
import { deleteFile, downloadFileToBuffer, uploadFile } from "../lib/r2.js";
import { OPTIMISED_KEY } from "../services/imageUpload.service.js";

const COMMIT = process.argv.includes("--commit");
const DELETE_OLD = process.argv.includes("--delete-old");

const PUBLIC_BASE = `${config.r2.publicUrlBase.replace(/\/$/, "")}/`;

interface Converted {
  newUrl: string;
  oldKey: string;
}

const totals = { converted: 0, skipped: 0, failed: 0, before: 0, after: 0 };
const oldKeysToDelete: string[] = [];

/** Reads one stored URL and, unless it is already fine, writes its WebP (only with --commit). */
async function convert(url: string, folder: string): Promise<Converted | null> {
  if (!url.startsWith(PUBLIC_BASE)) {
    console.log(`  skip (not in this bucket): ${url}`);
    totals.skipped++;
    return null;
  }
  const oldKey = url.slice(PUBLIC_BASE.length);
  if (OPTIMISED_KEY.test(oldKey)) {
    totals.skipped++;
    return null;
  }

  try {
    const original = await downloadFileToBuffer("public", oldKey);
    const optimised = await buildThumbnailImage(original);
    const newKey = `${folder}/${randomUUID()}.webp`;
    if (COMMIT) await uploadFile("public", newKey, optimised, "image/webp");
    console.log(
      `  ${COMMIT ? "converted" : "would convert"}: ${oldKey}  ${kb(original.length)} -> ${kb(optimised.length)}`
    );
    totals.before += original.length;
    totals.after += optimised.length;
    return {
      newUrl: `${PUBLIC_BASE}${newKey}`,
      oldKey,
    };
  } catch (error: any) {
    console.log(`  FAILED ${oldKey}: ${error?.message ?? error}`);
    totals.failed++;
    return null;
  }
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

async function comics() {
  const rows = await prisma.comic.findMany({
    select: { id: true, title: true, coverThumbnailUrls: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`comics: ${rows.length}`);

  for (const comic of rows) {
    const next: string[] = [];
    const replaced: Converted[] = [];
    for (const url of comic.coverThumbnailUrls) {
      const done = await convert(url, "comics/thumbnails");
      next.push(done?.newUrl ?? url);
      if (done) replaced.push(done);
    }
    if (replaced.length === 0) continue;
    console.log(
      `comic "${comic.title}" (${comic.id}): ${replaced.length} thumbnail(s)`
    );
    if (!COMMIT) continue;

    // Only if the row still holds what was read: an edit made meanwhile wins.
    const { count } = await prisma.comic.updateMany({
      where: {
        id: comic.id,
        coverThumbnailUrls: { equals: comic.coverThumbnailUrls },
      },
      data: { coverThumbnailUrls: next },
    });
    if (count === 1) {
      totals.converted += replaced.length;
      oldKeysToDelete.push(...replaced.map((r) => r.oldKey));
    } else {
      console.log(`  CHANGED MEANWHILE, left as it was: ${comic.id}`);
      totals.failed += replaced.length;
    }
  }
}

async function heroSlides() {
  const rows = await prisma.heroImage.findMany({
    select: { id: true, imageUrl: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`hero slides: ${rows.length}`);

  for (const slide of rows) {
    const done = await convert(slide.imageUrl, "hero-images");
    if (!done) continue;
    console.log(`hero slide ${slide.id}`);
    if (!COMMIT) continue;

    const { count } = await prisma.heroImage.updateMany({
      where: { id: slide.id, imageUrl: slide.imageUrl },
      data: { imageUrl: done.newUrl },
    });
    if (count === 1) {
      totals.converted++;
      oldKeysToDelete.push(done.oldKey);
    } else {
      console.log(`  CHANGED MEANWHILE, left as it was: ${slide.id}`);
      totals.failed++;
    }
  }
}

async function main() {
  console.log(COMMIT ? "MODE: commit" : "MODE: dry run (nothing is written)");
  // Where this will run, so it can be checked before --commit (host only, no credentials).
  console.log(
    `database host: ${new URL(process.env.DATABASE_URL ?? "postgresql://unset").hostname}`
  );
  console.log(`public bucket: ${config.r2.publicBucket}`);
  await comics();
  await heroSlides();

  if (COMMIT && DELETE_OLD) {
    let deleted = 0;
    for (const key of oldKeysToDelete) {
      // Never remove a file that some row still points at (a row skipped as
      // changed meanwhile, or two rows sharing one address).
      const url = `${PUBLIC_BASE}${key}`;
      const stillUsed =
        (await prisma.comic.count({
          where: { coverThumbnailUrls: { has: url } },
        })) +
          (await prisma.heroImage.count({ where: { imageUrl: url } })) >
        0;
      if (stillUsed) {
        console.log(`  kept (still in use): ${key}`);
        continue;
      }
      try {
        await deleteFile("public", key);
        deleted += 1;
      } catch (error: any) {
        console.log(
          `  could not delete old file ${key}: ${error?.message ?? error}`
        );
      }
    }
    console.log(`old files deleted: ${deleted} of ${oldKeysToDelete.length}`);
  } else if (COMMIT && oldKeysToDelete.length > 0) {
    console.log(
      `old files kept (${oldKeysToDelete.length}): no row uses them any more; they are left in R2`
    );
  }

  console.log(
    `\n${COMMIT ? "converted" : "would convert"}: ${COMMIT ? totals.converted : "see lines above"}` +
      ` | already fine or skipped: ${totals.skipped} | failed: ${totals.failed}` +
      ` | ${kb(totals.before)} -> ${kb(totals.after)}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
