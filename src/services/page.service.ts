import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  deleteFile,
  downloadFileToBuffer,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import {
  buildDisplayImage,
  probeImageDimensions,
  type ImageDimensions,
} from "../lib/image.js";
import { stampTextOnPage } from "../jobs/workers/sd/textStamp.js";
import { config } from "../config/env.js";
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import type {
  CreatePageInput,
  GetPageArtworkUploadUrlInput,
  PreviewPageStampInput,
  UpdatePageInput,
} from "../validators/page.schema.js";
import type { Bubble, Font } from "../generated/prisma/client.js";

const PAGE_ASSET_UPLOAD_EXPIRY_SECONDS = 15 * 60;

// Two artworks are treated as the same shape if their width/height ratios agree
// to within this tolerance. Never compare ratios with === — 2048/1536 and
// 4096/3072 are both 1.333... but not bit-identical.
const ASPECT_RATIO_TOLERANCE = 0.01;

const keyFromPublicUrl = (url: string): string => {
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  return url.replace(`${publicBase}/`, "");
};

/**
 * Fetches a page asset from the public bucket and reads its pixel dimensions.
 * A download failure here almost always means the client called POST/PATCH
 * before its R2 upload finished, so it surfaces as a 400 rather than a 500.
 */
async function probePageAsset(
  key: string,
  label: "artwork" | "mask"
): Promise<ImageDimensions> {
  let buffer: Buffer;

  try {
    buffer = await downloadFileToBuffer("public", key);
  } catch (error) {
    logger.warn({ error, key, label }, "Failed to download page asset from R2");
    throw new ValidationError(
      `The ${label} could not be read from storage. Confirm the file upload completed before saving the page.`
    );
  }

  return probeImageDimensions(buffer, label);
}

function assertMaskMatchesArtwork(
  mask: ImageDimensions,
  artwork: ImageDimensions
): void {
  if (mask.width === artwork.width && mask.height === artwork.height) return;

  throw new ValidationError(
    `Mask dimensions (${mask.width}x${mask.height}) must match artwork dimensions (${artwork.width}x${artwork.height}).`
  );
}

function aspectRatioChanged(
  before: ImageDimensions,
  after: ImageDimensions
): boolean {
  const beforeRatio = before.width / before.height;
  const afterRatio = after.width / after.height;

  return Math.abs(beforeRatio - afterRatio) > ASPECT_RATIO_TOLERANCE;
}

export async function getPageArtworkUploadUrl(
  comicId: string,
  input: GetPageArtworkUploadUrlInput
) {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });

  if (!comic) {
    throw new NotFoundError(
      "Comic not found while creating the page for that comic"
    );
  }

  const { fileExtension, fileType } = input;

  const contentTypeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };

  const contentType = contentTypeMap[fileExtension];
  const folder = fileType === "masks" ? "masks" : "artwork";
  // randomUUID prevents two upload-url requests in the same millisecond from
  // generating the same key and silently overwriting each other's file.
  const key =
    `comics/${comicId}/pages/${folder}/${randomUUID()}-${Date.now()}.${fileExtension}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    contentType!,
    PAGE_ASSET_UPLOAD_EXPIRY_SECONDS
  );

  return { uploadUrl, key };
}

export async function createPage(comicId: string, input: CreatePageInput) {
  const comic = await prisma.comic.findUnique({ where: { id: comicId } });

  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  const data: Prisma.PageCreateInput = {
    comic: { connect: { id: comicId } },
    pageNumber: input.pageNumber,
    hasFace: input.hasFace,
    mirrorFace: input.mirrorFace,
    isPreviewPage: input.isPreviewPage,
  };

  // Frontend sends the R2 key returned by getPageArtworkUploadUrl; we store the
  // resolved public URL so it is directly renderable by admin + public clients.
  if (input.artworkUrl !== undefined)
    data.artworkUrl = getPublicUrl(input.artworkUrl);
  if (input.maskUrl !== undefined) data.maskUrl = getPublicUrl(input.maskUrl);
  if (input.faceDirection !== undefined) data.faceDirection = input.faceDirection;
  if (input.pagePrompt !== undefined) data.pagePrompt = input.pagePrompt;
  if (input.steps !== undefined) data.steps = input.steps;
  if (input.cfg !== undefined) data.cfg = input.cfg;

  // Artwork dimensions are derived server-side, never accepted from the client.
  let artworkDimensions: ImageDimensions | null = null;

  if (input.artworkUrl !== undefined) {
    artworkDimensions = await probePageAsset(input.artworkUrl, "artwork");
    data.artworkWidth = artworkDimensions.width;
    data.artworkHeight = artworkDimensions.height;
  }

  // ComfyUI overlays mask and artwork pixel-for-pixel, so a size mismatch puts
  // the face in the wrong place on every copy. Reject it at upload time.
  // A mask supplied without artwork can't be checked yet — it gets validated in
  // updatePage() when artwork is eventually attached.
  if (input.maskUrl !== undefined && artworkDimensions) {
    const maskDimensions = await probePageAsset(input.maskUrl, "mask");
    assertMaskMatchesArtwork(maskDimensions, artworkDimensions);
  }

  try {
    const page = await prisma.page.create({ data });
    logger.info(
      { comicId, pageId: page.id, pageNumber: page.pageNumber },
      "Page created successfully"
    );
    return { ...page, warnings: [] as string[] };
  } catch (error: any) {
    if (error.code === "P2002") {
      throw new ConflictError(
        `Page number ${input.pageNumber} already exists for this comic`
      );
    }
    throw error;
  }
}


export async function listComicPages(comicId: string) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  const pages = await prisma.page.findMany({
    where: { comicId },
    orderBy: { pageNumber: "asc" },
    include: {
      bubbles: {
        orderBy: { sortOrder: "asc" },
        include: {
          font: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  logger.info({ comicId, pageCount: pages.length }, "Listed comic pages");

  return pages;
}

export async function updatePage(pageId: string, input: UpdatePageInput) {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
  });

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  const data: Prisma.PageUpdateInput = {};
  const oldR2KeysToDelete: string[] = [];
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");

  if (input.hasFace !== undefined) data.hasFace = input.hasFace;
  if (input.mirrorFace !== undefined) data.mirrorFace = input.mirrorFace;
  if (input.faceDirection !== undefined) data.faceDirection = input.faceDirection;
  if (input.isPreviewPage !== undefined) data.isPreviewPage = input.isPreviewPage;
  if (input.pagePrompt !== undefined) data.pagePrompt = input.pagePrompt;

  // Artwork / mask arrive as R2 keys and are stored as resolved public URLs.
  // When an asset is genuinely replaced, queue the old file for R2 cleanup.
  // Guard on `oldUrl !== newUrl` so re-submitting the same key does not delete
  // the file the page still points at.
  if (input.artworkUrl !== undefined) {
    const newArtworkUrl = getPublicUrl(input.artworkUrl);
    data.artworkUrl = newArtworkUrl;

    if (page.artworkUrl && page.artworkUrl !== newArtworkUrl) {
      oldR2KeysToDelete.push(page.artworkUrl.replace(`${publicBase}/`, ""));
    }
  }

  if (input.maskUrl !== undefined) {
    const newMaskUrl = getPublicUrl(input.maskUrl);
    data.maskUrl = newMaskUrl;

    if (page.maskUrl && page.maskUrl !== newMaskUrl) {
      oldR2KeysToDelete.push(page.maskUrl.replace(`${publicBase}/`, ""));
    }
  }

  if (input.steps !== undefined) data.steps = input.steps;
  if (input.cfg !== undefined) data.cfg = input.cfg;

  // ---- Dimension handling -------------------------------------------------
  // Validation runs against the page's RESULTING state, not just the incoming
  // fields. Replacing only the artwork can invalidate a mask that wasn't in the
  // payload at all, so an untouched mask still has to be re-checked.
  const warnings: string[] = [];
  const artworkChanged =
    input.artworkUrl !== undefined && data.artworkUrl !== page.artworkUrl;

  let resultingArtwork: ImageDimensions | null =
    page.artworkWidth && page.artworkHeight
      ? { width: page.artworkWidth, height: page.artworkHeight }
      : null;

  if (artworkChanged) {
    const previousArtwork = resultingArtwork;

    resultingArtwork = await probePageAsset(input.artworkUrl!, "artwork");
    data.artworkWidth = resultingArtwork.width;
    data.artworkHeight = resultingArtwork.height;

    // A pure resolution change is harmless — bubble coords are normalized.
    // Only a changed aspect ratio actually distorts placement, so only warn
    // for that. Never blocks the update.
    if (previousArtwork && aspectRatioChanged(previousArtwork, resultingArtwork)) {
      warnings.push(
        `Artwork aspect ratio changed from ${previousArtwork.width}x${previousArtwork.height} to ${resultingArtwork.width}x${resultingArtwork.height}. Re-check bubble positions on this page.`
      );
    }
  }

  // Decide which mask needs checking:
  //   - a newly supplied mask, or
  //   - the existing mask, when the artwork underneath it just changed.
  // A PATCH that touches neither asset performs zero R2 downloads.
  let maskKeyToVerify: string | null = null;

  if (input.maskUrl !== undefined) {
    maskKeyToVerify = input.maskUrl;
  } else if (artworkChanged && page.maskUrl) {
    maskKeyToVerify = keyFromPublicUrl(page.maskUrl);
  }

  if (maskKeyToVerify && resultingArtwork) {
    const maskDimensions = await probePageAsset(maskKeyToVerify, "mask");
    assertMaskMatchesArtwork(maskDimensions, resultingArtwork);
  }

  const updated = await prisma.page.update({
    where: { id: pageId },
    data,
  });

  // Best-effort cleanup — the DB update must stand even if R2 is unreachable.
  for (const oldR2Key of oldR2KeysToDelete) {
    try {
      await deleteFile("public", oldR2Key);
      logger.info({ pageId, oldR2Key }, "Old page asset deleted from R2");
    } catch (error) {
      logger.warn(
        { error, pageId, oldR2Key },
        "Failed to delete old page asset from R2"
      );
    }
  }

  logger.info(
    { pageId, comicId: page.comicId, fields: Object.keys(data), warnings },
    "Page updated"
  );

  return { ...updated, warnings };
}

export async function deletePage(pageId: string) {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
  });

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  // Collect the R2 keys we'll clean up BEFORE the DB delete, so we still
  // have access to page.artworkUrl and page.maskUrl. Nothing hits R2 yet.
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const r2KeysToDelete = [page.artworkUrl, page.maskUrl]
    .filter((url): url is string => Boolean(url))
    .map((url) => url.replace(`${publicBase}/`, ""));

  // DB delete is the moment of truth. If it throws, we haven't touched R2 —
  // caller sees an error and the page + its assets stay intact, exactly
  // recoverable by retrying the delete. (Audit 8.9 — DB first, R2 second.)
  await prisma.page.delete({
    where: { id: pageId },
  });

  // Best-effort R2 cleanup AFTER the DB delete succeeded. Failures here mean
  // orphaned files (wasted storage) but never a page row pointing at 404s.
  for (const key of r2KeysToDelete) {
    try {
      await deleteFile("public", key);
      logger.info({ pageId, key }, "Deleted page asset from R2");
    } catch (error) {
      logger.warn(
        { error, pageId, key },
        "Failed to delete page asset from R2 after DB delete — orphaned file"
      );
    }
  }

  logger.info(
    { pageId, comicId: page.comicId, pageNumber: page.pageNumber },
    "Page deleted (bubbles cascade-deleted)"
  );
}


export async function reorderComicPages(
  comicId: string,
  orderedPageIds: string[]
) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true, status: true },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  // Reordering a live comic changes the page order customers are browsing.
  if (comic.status === "PUBLISHED") {
    throw new ConflictError(
      "Cannot reorder pages of a published comic. Unpublish it first."
    );
  }

  // Unpublishing does NOT cancel in-flight sessions, and PDF compilation
  // orders pages by pageNumber — reordering mid-order would reshuffle a book
  // someone already paid for. Same guard deleteComic uses.
  const activeSessionCount = await prisma.orderSession.count({
    where: {
      comicId,
      status: { notIn: ["COMPLETED", "FAILED"] },
    },
  });

  if (activeSessionCount > 0) {
    throw new ConflictError(
      `Cannot reorder pages — this comic has ${activeSessionCount} active order session(s). Wait for them to complete or fail first.`
    );
  }

  const pages = await prisma.page.findMany({
    where: { comicId },
    select: { id: true },
  });

  // A partial list would renumber a subset into 1..n and collide with the
  // pages left untouched. The full set is mandatory.
  if (pages.length !== orderedPageIds.length) {
    throw new ValidationError(
      `orderedPageIds must contain all ${pages.length} page(s) of this comic — received ${orderedPageIds.length}.`
    );
  }

  const existingIds = new Set(pages.map((p) => p.id));
  const foreignIds = orderedPageIds.filter((id) => !existingIds.has(id));

  if (foreignIds.length > 0) {
    throw new ValidationError(
      `These page IDs do not belong to this comic: ${foreignIds.join(", ")}`
    );
  }

  // Two-phase renumber. @@unique([comicId, pageNumber]) is enforced per
  // statement (Prisma's unique constraints are not deferrable), so writing
  // final numbers directly fails the moment two pages swap. Park everything
  // on negatives first — createPageSchema enforces positive(), so no real
  // page can ever hold one.
  await prisma.$transaction(async (tx) => {
    for (const [index, id] of orderedPageIds.entries()) {
      await tx.page.update({
        where: { id },
        data: { pageNumber: -(index + 1) },
      });
    }

    for (const [index, id] of orderedPageIds.entries()) {
      await tx.page.update({
        where: { id },
        data: { pageNumber: index + 1 },
      });
    }
  });

  logger.info({ comicId, orderedPageIds }, "Comic pages reordered");

  return listComicPages(comicId);
}

/**
 * Render a page's text stamping for the admin bubble mapper — no face swap.
 *
 * This is the SAME renderer the generation pipeline uses, called with bubbles
 * supplied by the browser instead of read from the DB. That is deliberate: the
 * mapper holds unsaved edits locally, so rendering stored rows would show the
 * admin something other than what is on their screen.
 *
 * Nothing is persisted. No DB writes, no R2 uploads, no PageVersion, no
 * session. A buffer is produced, encoded, and dropped.
 *
 * Accuracy note: for a page with `hasFace: false` this is not an approximation
 * — the pipeline's stamped image IS the final image for those pages. For face
 * pages it is the exact input the face swap receives.
 */
export async function previewPageTextStamp(
  pageId: string,
  input: PreviewPageStampInput
) {
  const page = await prisma.page.findUnique({ where: { id: pageId } });

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  // Checked here rather than letting the renderer throw: it needs all three and
  // its own error is written for a worker log, not for an admin looking at a
  // modal wondering what went wrong.
  if (!page.artworkUrl || !page.artworkWidth || !page.artworkHeight) {
    throw new ValidationError(
      "This page has no artwork yet. Upload artwork before previewing."
    );
  }

  // --- Resolve fonts, one query for the whole page ---
  const fontIds = [
    ...new Set(
      input.bubbles
        .map((bubble) => bubble.fontId)
        .filter((fontId): fontId is string => Boolean(fontId))
    ),
  ];

  const fonts = fontIds.length
    ? await prisma.font.findMany({ where: { id: { in: fontIds } } })
    : [];

  const fontsById = new Map(fonts.map((font) => [font.id, font]));

  // Same guard updateBubble applies. Without it an admin could preview using
  // another comic's font, which would render something the real generation
  // could never produce.
  for (const font of fonts) {
    if (font.comicId !== page.comicId) {
      throw new ConflictError(
        "A font does not belong to the same comic as this page"
      );
    }
  }

  // --- Shape the incoming bubbles into what the renderer expects ---
  //
  // stampTextOnPage wants full Bubble rows joined to their Font. These are
  // drafts, so id/pageId/timestamps are synthesised. The client's draft id is
  // passed through where present purely because the renderer names the bubble
  // in its error messages, and a real draft id is far more useful there than a
  // placeholder would be.
  const now = new Date();

  const bubbles: (Bubble & { font: Font | null })[] = input.bubbles.map(
    (bubble, index) => ({
      id: bubble.id ?? `preview-${index}`,
      pageId: page.id,
      x: bubble.x,
      y: bubble.y,
      width: bubble.width,
      height: bubble.height,
      dialogue: bubble.dialogue,
      fontId: bubble.fontId ?? null,
      fontSize: bubble.fontSize,
      fontColor: bubble.fontColor,
      nameColor: bubble.nameColor ?? null,
      textAlign: bubble.textAlign,
      textVerticalAlign: bubble.textVerticalAlign,
      textCase: bubble.textCase,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
      font: bubble.fontId ? (fontsById.get(bubble.fontId) ?? null) : null,
    })
  );

  const stampedBuffer = await stampTextOnPage({
    page,
    bubbles,
    childName: input.childName,
    pronounKey: input.pronounKey,
  });

  // The print master is 4–5 MB of lossless PNG; a browser preview does not need
  // that. Best-effort, exactly as the worker treats it — a resize failure must
  // not throw away a render that already succeeded, so fall back to the PNG.
  let imageBuffer = stampedBuffer;
  let contentType = "image/png";

  try {
    imageBuffer = await buildDisplayImage(stampedBuffer);
    contentType = "image/webp";
  } catch (error) {
    logger.warn(
      { error, pageId },
      "Preview display derivative failed; falling back to the full-size PNG"
    );
  }

  logger.info(
    {
      pageId,
      bubbleCount: bubbles.length,
      childName: input.childName,
      pronounKey: input.pronounKey,
      bytes: imageBuffer.byteLength,
      contentType,
    },
    "Rendered bubble mapping preview"
  );

  return {
    // A data URI so the response still travels through sendSuccess like every
    // other admin endpoint. Raw bytes would bypass the response envelope and
    // the frontend's axios interceptor that unwraps it.
    image: `data:${contentType};base64,${imageBuffer.toString("base64")}`,
    artworkWidth: page.artworkWidth,
    artworkHeight: page.artworkHeight,
  };
}
