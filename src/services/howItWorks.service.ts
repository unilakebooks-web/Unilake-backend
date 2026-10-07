import { randomUUID } from "node:crypto";
import {
  deleteFile,
  getKeyFromPublicUrl,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { HowItWorksStep } from "../validators/howItWorks.schema.js";

const VIDEO_UPLOAD_EXPIRY_SECONDS = 30 * 60;
const POSTER_UPLOAD_EXPIRY_SECONDS = 15 * 60;

// Deterministic pick when more than one row exists (should never happen —
// see updateHowItWorks — but if it ever does, both admin and public reads
// must agree on the same row rather than picking arbitrarily).
const SINGLETON_ORDER_BY = { createdAt: "asc" as const };

export async function getHowItWorksUploadUrl(data: {
  assetType: "video" | "poster";
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `how-it-works/${randomUUID()}-${safeFileName}`;

  const expirySeconds =
    data.assetType === "video"
      ? VIDEO_UPLOAD_EXPIRY_SECONDS
      : POSTER_UPLOAD_EXPIRY_SECONDS;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    expirySeconds
  );

  logger.info({ key, assetType: data.assetType }, "Generated How It Works upload URL");

  return { uploadUrl, key };
}

/**
 * Public read. Deliberately stricter than the admin read: a section only
 * ever reaches the homepage once it has a video AND at least one step, even
 * if isActive is already true. This keeps a half-finished edit from ever
 * being visible — the admin's job is to finish it, not to remember to flip
 * isActive at exactly the right moment.
 */
export async function getPublicHowItWorks() {
  const row = await prisma.howItWorks.findFirst({
    where: { isActive: true },
    orderBy: SINGLETON_ORDER_BY,
  });

  if (!row) return null;

  const steps = (row.steps ?? []) as HowItWorksStep[];

  if (!row.videoUrl || steps.length === 0) return null;

  return { ...row, steps };
}

/**
 * Admin read. No isActive filter and no readiness check — the admin needs
 * to see and edit the section while it's still incomplete.
 */
export async function getAdminHowItWorks() {
  const row = await prisma.howItWorks.findFirst({
    orderBy: SINGLETON_ORDER_BY,
  });

  if (!row) return null;

  const steps = (row.steps ?? []) as HowItWorksStep[];

  return { ...row, steps };
}

/**
 * Singleton create-or-update. There is no :id on this endpoint by design —
 * find the one row (if any), create it on the first call, update it on
 * every call after. Ordered by createdAt so that in the vanishingly
 * unlikely case two concurrent first-saves both created a row, every read
 * afterwards deterministically agrees on the same one.
 */
export async function updateHowItWorks(data: {
  videoKey?: string | null;
  posterKey?: string | null;
  steps?: HowItWorksStep[];
  isActive?: boolean;
}) {
  const existing = await prisma.howItWorks.findFirst({
    orderBy: SINGLETON_ORDER_BY,
  });

  const updateData: Prisma.HowItWorksUpdateInput = {};
  const oldR2Keys: string[] = [];

  if (data.steps !== undefined) {
    updateData.steps = data.steps as unknown as Prisma.InputJsonValue;
  }
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  // Asset replace/clear, same guard as updateTeamMember: compare old vs new
  // resolved URL before queuing an R2 delete, so re-submitting the same key
  // never deletes the file the row still points at.
  if (data.videoKey !== undefined) {
    const newVideoUrl = data.videoKey === null ? null : getPublicUrl(data.videoKey);
    updateData.videoUrl = newVideoUrl;

    if (existing?.videoUrl && existing.videoUrl !== newVideoUrl) {
      oldR2Keys.push(getKeyFromPublicUrl(existing.videoUrl));
    }
  }

  if (data.posterKey !== undefined) {
    const newPosterUrl = data.posterKey === null ? null : getPublicUrl(data.posterKey);
    updateData.posterUrl = newPosterUrl;

    if (existing?.posterUrl && existing.posterUrl !== newPosterUrl) {
      oldR2Keys.push(getKeyFromPublicUrl(existing.posterUrl));
    }
  }

  const row = existing
    ? await prisma.howItWorks.update({
        where: { id: existing.id },
        data: updateData,
      })
    : await prisma.howItWorks.create({
        data: updateData as Prisma.HowItWorksCreateInput,
      });

  // Best-effort, after the DB write succeeds. A failed delete leaves an
  // orphan file in R2, not a broken row.
  for (const key of oldR2Keys) {
    try {
      await deleteFile("public", key);
      logger.info({ key }, "Old How It Works asset deleted from R2");
    } catch (error) {
      logger.warn(
        { error, key },
        "How It Works asset replaced/cleared but old R2 file cleanup failed"
      );
    }
  }

  logger.info(
    { id: row.id, created: !existing, updatedFields: Object.keys(updateData) },
    existing ? "How It Works updated" : "How It Works created"
  );

  return { ...row, steps: (row.steps ?? []) as HowItWorksStep[] };
}
