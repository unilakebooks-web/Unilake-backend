import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getPublicUrl, getSignedUploadUrl, deleteFile } from "../lib/r2.js";
import { config } from "../config/env.js";
import { NotFoundError } from "../utils/errors.js";

const UPLOAD_EXPIRY_SECONDS = 30 * 60;

/** Public URL -> R2 key. Same derivation used by teamMember/customerReview. */
function keyFromPublicUrl(url: string): string {
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  return url.replace(`${publicBase}/`, "");
}

export async function getGoogleReviewUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `google-reviews/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated Google review image upload URL");

  return { uploadUrl, key };
}

export async function createGoogleReview(data: {
  customerName: string;
  rating: number;
  reviewText: string;
  imageKey: string;
}) {
  const review = await prisma.googleReview.create({
    data: {
      customerName: data.customerName,
      rating: data.rating,
      reviewText: data.reviewText,
      imageUrl: getPublicUrl(data.imageKey),
    },
  });

  logger.info(
    { reviewId: review.id, rating: review.rating },
    "Google review created"
  );

  return review;
}

export async function updateGoogleReview(
  id: string,
  data: {
    customerName?: string;
    rating?: number;
    reviewText?: string;
    imageKey?: string;
  }
) {
  const existing = await prisma.googleReview.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Google review not found");
  }

  const updateData: Record<string, unknown> = {};

  // `!== undefined` rather than truthiness — a rating of 0 would be rejected
  // by Zod, but the same pattern keeps every field consistent.
  if (data.customerName !== undefined) updateData.customerName = data.customerName;
  if (data.rating !== undefined) updateData.rating = data.rating;
  if (data.reviewText !== undefined) updateData.reviewText = data.reviewText;

  // Image: omitted = keep, a key = replace. There is no clear case — the
  // column is NOT NULL, which is why the validator refuses null here.
  //
  // Guard on oldUrl !== newUrl so an edit form that re-submits the SAME key
  // does not delete the file the row still points at. Same guard as
  // updateTeamMember and updatePage.
  let oldR2Key: string | null = null;

  if (data.imageKey !== undefined) {
    const newImageUrl = getPublicUrl(data.imageKey);
    updateData.imageUrl = newImageUrl;

    if (existing.imageUrl !== newImageUrl) {
      oldR2Key = keyFromPublicUrl(existing.imageUrl);
    }
  }

  const updated = await prisma.googleReview.update({
    where: { id },
    data: updateData,
  });

  // Best-effort, after the DB write succeeds. A failed delete leaves an orphan
  // file in R2, not a broken row.
  if (oldR2Key) {
    try {
      await deleteFile("public", oldR2Key);
      logger.info(
        { reviewId: id, oldR2Key },
        "Old Google review image deleted from R2"
      );
    } catch (error) {
      logger.warn(
        { error, reviewId: id, oldR2Key },
        "Google review image replaced but old R2 file cleanup failed"
      );
    }
  }

  logger.info(
    { reviewId: id, updatedFields: Object.keys(updateData) },
    "Google review updated"
  );

  return updated;
}

export async function toggleGoogleReviewStatus(id: string) {
  const existing = await prisma.googleReview.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Google review not found");
  }

  const updated = await prisma.googleReview.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { reviewId: id, isActive: updated.isActive },
    "Google review status toggled"
  );

  return updated;
}

export async function deleteGoogleReview(id: string) {
  const existing = await prisma.googleReview.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Google review not found");
  }

  const r2Key = keyFromPublicUrl(existing.imageUrl);

  // DB row first, then best-effort R2 cleanup — same ordering as
  // CustomerReview, TeamMember and Blog.
  await prisma.googleReview.delete({ where: { id } });

  try {
    await deleteFile("public", r2Key);
    logger.info({ reviewId: id, r2Key }, "Google review and R2 image deleted");
  } catch (error) {
    logger.warn(
      { error, reviewId: id, r2Key },
      "Google review deleted but R2 cleanup failed"
    );
  }
}

/** Admin list — no isActive filter, the admin needs to see hidden rows too. */
export async function getAllGoogleReviews() {
  return prisma.googleReview.findMany({
    orderBy: { createdAt: "desc" },
  });
}

/** Public list — active only, newest first. Backed by @@index([isActive, createdAt]). */
export async function getActiveGoogleReviews() {
  return prisma.googleReview.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
}
