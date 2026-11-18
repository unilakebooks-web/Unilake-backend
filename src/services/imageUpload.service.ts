import { randomUUID } from "node:crypto";
import { deleteFile, downloadFileToBuffer, uploadFile } from "../lib/r2.js";
import { buildThumbnailImage } from "../lib/image.js";
import { logger } from "../lib/logger.js";
import { ValidationError } from "../utils/errors.js";

/**
 * Optimises images the admin uploads straight to R2 for the storefront (comic
 * cover thumbnails and hero slides).
 *
 * The browser PUTs the raw file to a presigned URL, so the server only learns of
 * it when the admin saves the comic or slide. At that point each new file is
 * read back, shrunk to a web-sized WebP (lib/image.ts) and written under a new
 * key; the row then stores the new key's URL. Same shape as probePageAsset in
 * page.service.ts (download, sharp, fail with a ValidationError), but it keeps
 * the result instead of only reading the size.
 *
 * Rules that matter:
 *  - No R2 call inside a database transaction: callers run this first.
 *  - The raw upload is deleted only AFTER the row is saved. Deleting it first
 *    would make a retry after a failed save impossible: the file the admin
 *    picked would be gone.
 *  - If the save fails after this has written the optimised files, the caller
 *    removes them again (deleteUploadedFiles), so a failed request leaves no
 *    stray files. A crash between the two can still leave one; that costs
 *    storage only, nothing points at it.
 */

/** Images processed at the same time: a decoded large image takes memory, and the API shares it. */
const CONCURRENCY = 3;

/** A key this code wrote (`<folder>/<uuid>.webp`): never a raw upload, so never processed again. */
export const OPTIMISED_KEY = /\/[0-9a-f-]{36}\.webp$/;

export interface OptimisedUpload {
  /** Key of the new, optimised WebP: the one to store. */
  key: string;
  /** Key of the raw upload: delete it once the row is saved. */
  originalKey: string;
}

async function optimiseOne(
  originalKey: string,
  folder: string,
  rawPrefix: string
): Promise<OptimisedUpload> {
  // Only a file the admin just uploaded may be processed, and then deleted. A
  // key of some other file (another comic's image, a stored slide) is refused.
  if (!originalKey.startsWith(rawPrefix) || OPTIMISED_KEY.test(originalKey)) {
    throw new ValidationError(
      "An uploaded image is not valid. Please upload it again."
    );
  }

  let original: Buffer;
  try {
    original = await downloadFileToBuffer("public", originalKey);
  } catch (error) {
    logger.warn(
      { error, originalKey },
      "Uploaded image could not be read from R2"
    );
    throw new ValidationError(
      "An uploaded image was not found. Please upload it again."
    );
  }

  const optimised = await buildThumbnailImage(original);
  const key = `${folder}/${randomUUID()}.webp`;
  await uploadFile("public", key, optimised, "image/webp");

  logger.info(
    {
      originalKey,
      key,
      bytesBefore: original.length,
      bytesAfter: optimised.length,
    },
    "Uploaded image optimised"
  );
  return { key, originalKey };
}

/**
 * Optimises every key, a few at a time. If any one fails, the ones that
 * succeeded are removed again and the first error is thrown, so a failed request
 * leaves no stray files. Results come back in the order of `originalKeys`.
 *
 * `rawPrefix` is where the raw uploads of this kind are put (their presigned
 * keys start with it); `folder` is where the optimised files go.
 */
export async function optimiseUploadedImages(
  originalKeys: string[],
  folder: string,
  rawPrefix: string
): Promise<OptimisedUpload[]> {
  const done: OptimisedUpload[] = [];

  for (let i = 0; i < originalKeys.length; i += CONCURRENCY) {
    const results = await Promise.allSettled(
      originalKeys
        .slice(i, i + CONCURRENCY)
        .map((key) => optimiseOne(key, folder, rawPrefix))
    );
    done.push(
      ...results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    );

    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    if (failed) {
      await deleteUploadedFiles(done.map((o) => o.key));
      throw failed.reason;
    }
  }

  return done;
}

/** Optimises a single key. */
export async function optimiseUploadedImage(
  originalKey: string,
  folder: string,
  rawPrefix: string
): Promise<OptimisedUpload> {
  // One key in, so exactly one result out.
  return (await optimiseUploadedImages([originalKey], folder, rawPrefix))[0]!;
}

/**
 * Deletes files from R2, best effort: never throws. Used for the raw uploads once
 * the row that replaced them is saved, and for the optimised files when it was not.
 */
export async function deleteUploadedFiles(keys: string[]) {
  for (const key of keys) {
    try {
      await deleteFile("public", key);
    } catch (error) {
      logger.warn({ error, key }, "Could not delete an uploaded file from R2");
    }
  }
}
