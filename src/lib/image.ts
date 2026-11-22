import sharp from "sharp";
import { ValidationError } from "../utils/errors.js";
import { logger } from "./logger.js";

export type ImageDimensions = {
  width: number;
  height: number;
};

/**
 * Long edge of the browser-facing derivative, in pixels.
 *
 * The preview viewer renders pages in a box capped at 800 CSS px, so 1600
 * covers a 2× retina display exactly with nothing wasted.
 */
const DISPLAY_MAX_EDGE = 1600;

/** WebP quality for the derivative. 80 is visually lossless on this artwork. */
const DISPLAY_WEBP_QUALITY = 80;

/**
 * Builds the browser-facing version of a finished page image.
 *
 * Why this exists: the image we store at `PageVersion.finalImageUrl` is a
 * lossless PNG at print resolution - around 4–5 MB per page. That is correct
 * for the printed book and wrong for a web page: a six-page preview came to
 * ~27 MB, which is roughly 90 seconds on 4G.
 *
 * Nearly all of that is the format, not the resolution. PNG stores every pixel
 * exactly; this artwork is photographic (face-swapped comic art), which is what
 * WebP is built for. The same image lands around 250 KB - an ~18× reduction with
 * no visible difference.
 *
 * The print master is untouched. This is an additional, separate file.
 *
 * @param buffer - The finished page image, as uploaded to `finalImageUrl`
 * @returns WebP bytes, ready to upload
 */
export const buildDisplayImage = async (buffer: Buffer): Promise<Buffer> => {
  return sharp(buffer)
    .resize({
      width: DISPLAY_MAX_EDGE,
      height: DISPLAY_MAX_EDGE,
      // "inside" caps the LONG edge at DISPLAY_MAX_EDGE and preserves aspect
      // ratio - it never crops, so the page is never silently reframed.
      fit: "inside",
      // Source artwork is ~2000px on the long edge, but a smaller page must not
      // be upscaled: that would add bytes and blur for no gain.
      withoutEnlargement: true,
    })
    .webp({ quality: DISPLAY_WEBP_QUALITY })
    .toBuffer();
};

/**
 * Reads the real pixel dimensions of an image buffer.
 *
 * Used to (a) record Page.artworkWidth/artworkHeight, (b) verify a mask matches
 * its artwork pixel-for-pixel, and (c) detect aspect-ratio changes when artwork
 * is replaced. The SD worker imports from this module too.
 *
 * @param buffer - Raw image bytes, typically from downloadFileToBuffer()
 * @param label - Human-readable name used in error messages, e.g. "artwork"
 * @throws ValidationError if the buffer is not a readable image
 */
export const probeImageDimensions = async (
  buffer: Buffer,
  label = "image"
): Promise<ImageDimensions> => {
  let metadata;

  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    logger.warn({ error, label }, "Sharp failed to read image metadata");
    throw new ValidationError(
      `The uploaded ${label} could not be read as an image. Upload a valid PNG, JPEG or WEBP file.`
    );
  }

  // Sharp resolves without throwing for some malformed files, but leaves
  // width/height undefined - treat that as unreadable rather than trusting it.
  if (!metadata.width || !metadata.height) {
    logger.warn({ label, metadata }, "Image metadata missing dimensions");
    throw new ValidationError(
      `Could not determine the dimensions of the uploaded ${label}. The file may be corrupt.`
    );
  }

  return { width: metadata.width, height: metadata.height };
};

/** Long edge of an optimised cover thumbnail or hero image, in pixels. */
const THUMBNAIL_MAX_EDGE = 1200;

/** WebP quality for those. 82 keeps illustrated covers clean at about a tenth of the PNG's size. */
const THUMBNAIL_WEBP_QUALITY = 82;

/**
 * Shrinks an image the admin uploaded for the storefront (a comic's cover
 * thumbnails, a hero slide) to a web-sized WebP.
 *
 * Those files used to be stored exactly as picked, and covers of 1 to 10 MB were
 * downloaded for a card a few hundred pixels wide. The long edge is capped at
 * THUMBNAIL_MAX_EDGE, which still covers a 2x display of the largest place one
 * is drawn. Never for page artwork or masks: those are the print masters.
 *
 * `rotate()` applies the camera's orientation flag before the metadata is
 * dropped, so a phone photo does not come out sideways.
 *
 * @param buffer - The uploaded file, as read back from R2
 * @returns WebP bytes, ready to upload
 * @throws ValidationError if the bytes are not a readable image
 */
export const buildThumbnailImage = async (buffer: Buffer): Promise<Buffer> => {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
        // "inside" caps the long edge and keeps the aspect ratio: never crops.
        fit: "inside",
        // A small image is not enlarged: that adds bytes and blur for nothing.
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer();
  } catch (error) {
    logger.warn({ error }, "Sharp failed to optimise an uploaded image");
    throw new ValidationError(
      "The uploaded image could not be read. Upload a valid PNG, JPEG or WEBP file."
    );
  }
};
