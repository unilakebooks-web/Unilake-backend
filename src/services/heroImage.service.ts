import { randomUUID } from "node:crypto";
import { getPublicUrl, getSignedUploadUrl, deleteFile } from "../lib/r2.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";
import { config } from "../config/env.js";

const UPLOAD_EXPIRY_SECONDS = 15 * 60;

export async function getHeroImageUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `hero-images/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated hero image upload URL");

  return { uploadUrl, key };
}

export async function createHeroImage(data: { imageKey: string }) {
  const imageUrl = getPublicUrl(data.imageKey);

  const heroImage = await prisma.heroImage.create({
    data: {
      imageUrl,
    },
  });

  logger.info({ heroImageId: heroImage.id }, "Hero image created");

  return heroImage;
}

export async function toggleHeroImageStatus(id: string) {
  const existing = await prisma.heroImage.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Hero image not found");
  }

  const updated = await prisma.heroImage.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { heroImageId: id, isActive: updated.isActive },
    "Hero image status toggled"
  );

  return updated;
}

export async function getAllHeroImages() {
  const heroImages = await prisma.heroImage.findMany({
    orderBy: { createdAt: "desc" },
  });

  return heroImages;
}

export async function getActiveHeroImages() {
  const heroImages = await prisma.heroImage.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return heroImages;
}

export async function deleteHeroImage(id: string) {
  const existing = await prisma.heroImage.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Hero image not found");
  }
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const r2Key = existing.imageUrl.replace(`${publicBase}/`, "");

  await prisma.heroImage.delete({ where: { id } });

  try {
    await deleteFile("public", r2Key);
    logger.info(
      { heroImageId: id, r2Key },
      "Hero immage has been deleted successsfully"
    );
  } catch (error: any) {
    logger.warn({ error, heroImageId: id, r2Key }, "Hero image deleted from the database but R2 cleanup failed");
  }

  logger.info({ heroImageId: id }, "Hero image deleted");
}
