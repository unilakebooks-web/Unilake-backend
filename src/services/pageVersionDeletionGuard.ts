import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Automatic data deletion (feature 6): a page version of a session whose files were deleted can never be made (the
 * photo is gone). The generation worker calls this first: when the session is marked, the version is failed at once
 * and the job ends, instead of the job retrying against missing files. Returns true when the job must stop.
 */
export async function failPageVersionIfFilesDeleted(
  pageVersionId: string,
  session: {
    id: string;
    filesDeletedAt: Date | null;
    photoDeletedAt: Date | null;
  }
): Promise<boolean> {
  if (!session.filesDeletedAt && !session.photoDeletedAt) return false;
  await prisma.pageVersion.updateMany({
    where: { id: pageVersionId, status: { notIn: ["SD_READY", "FAILED"] } },
    data: {
      status: "FAILED",
      errorMessage: "The files of this preview were deleted",
    },
  });
  logger.warn(
    { pageVersionId, sessionId: session.id },
    "[SD Worker] The files of this session were deleted; page version failed, job dropped"
  );
  return true;
}
