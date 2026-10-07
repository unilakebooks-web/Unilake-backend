import { randomUUID } from "node:crypto";
import { getSignedUploadUrl } from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { getPublicUrl, deleteFile  } from "../lib/r2.js";
import { config } from "../config/env.js";
import { NotFoundError } from "../utils/errors.js";

const UPLOAD_EXPIRY_SECONDS = 30 * 60;

export async function getCustomerReviewUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `customer-reviews/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated customer review video upload URL");

  return { uploadUrl, key };
}


export async function createCustomerReview(data: {
  customerName: string;
  description: string;
  videoKey: string;
}) {
  const videoUrl = getPublicUrl(data.videoKey);

  const review = await prisma.customerReview.create({
    data: {
      customerName: data.customerName,
      description: data.description,
      videoUrl,
    },
  });

  logger.info({ reviewId: review.id }, "Customer review created");

  return review;
}

export async function toggleCustomerReviewStatus(id: string) {
  const existing = await prisma.customerReview.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Customer review not found");
  }

  const updated = await prisma.customerReview.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info({ reviewId: id, isActive: updated.isActive }, "Customer review status toggled");

  return updated;
}

export async function deleteCustomerReview(id: string) {
  const existing = await prisma.customerReview.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Customer review not found");
  }
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const r2Key = existing.videoUrl.replace(`${publicBase}/`, "");

  await prisma.customerReview.delete({ where: { id } });

  try {
    await deleteFile("public", r2Key);
    logger.info({ reviewId: id, r2Key }, "Customer review and R2 asset deleted");
  } catch (error) {
    logger.warn({ error, reviewId: id, r2Key }, "Customer review deleted but R2 cleanup failed");
  }
}

export async function getAllCustomerReviews() {
  const reviews = await prisma.customerReview.findMany({
    orderBy: { createdAt: "desc" },
  });

  return reviews;
}

export async function getActiveCustomerReviews() {
  const reviews = await prisma.customerReview.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return reviews;
}
