import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { downloadFileToBuffer, getKeyFromPublicUrl } from "../lib/r2.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import {
  MAX_LIVE_SAMPLES_OVERALL,
  MAX_LIVE_SAMPLES_PER_ADMIN,
  MAX_SAMPLE_PAGES,
  MAX_SAMPLE_PAGES_IN_FLIGHT,
  MAX_SAMPLE_PDF_BYTES,
  SAMPLE_TRANSACTION_OPTIONS,
  SAMPLE_TTL_MS,
} from "../config/sample.js";
import type {
  CreateSampleInput,
  SampleSelectionsInput,
} from "../validators/sample.schema.js";

// Same pattern as ROLE_CHANGE_LOCK_KEY in user.service.ts: one lock so two admins creating a sample at
// the same moment cannot both read the same count and both insert.
const SAMPLE_CREATE_LOCK_KEY = "sample-create";

/**
 * Creates an admin's sample book: a real OrderSession flagged isSample whose page list holds ONLY the
 * chosen pages, all flagged free, so the unchanged preview path generates exactly those pages. The
 * photo, generate, regenerate and poll steps then use the ordinary session routes with this id.
 *
 * ⚠️ Mirrors createOrderSession in session.service.ts (which stays untouched). Any comic may be used,
 * drafts included: an admin tries a book before publishing it.
 */
export async function createSample(input: CreateSampleInput, adminId: string) {
  const comic = await prisma.comic.findUnique({
    where: { id: input.comicId },
    select: { id: true },
  });
  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  // The route validator already limits the pages; this is also checked here because tests and scripts
  // call the service directly.
  const uniquePageIds = [...new Set(input.pageIds)];
  if (uniquePageIds.length !== input.pageIds.length) {
    throw new ValidationError("Each page can be chosen only once");
  }
  if (uniquePageIds.length > MAX_SAMPLE_PAGES) {
    throw new ValidationError(`Choose at most ${MAX_SAMPLE_PAGES} pages`);
  }

  const pages = await prisma.page.findMany({
    where: { id: { in: uniquePageIds }, comicId: input.comicId },
    select: {
      id: true,
      pageNumber: true,
      artworkUrl: true,
      artworkWidth: true,
      artworkHeight: true,
      hasFace: true,
      maskUrl: true,
      pagePrompt: true,
    },
  });
  if (pages.length !== uniquePageIds.length) {
    throw new ValidationError("Every chosen page must belong to this comic");
  }
  // The generation worker fails a page without artwork, or a face page without its mask and
  // prompt, after its retries (generationWorker.ts, "Face-only requirements"). Refuse them here.
  const noArtwork = pages.filter(
    (p) => !p.artworkUrl || !p.artworkWidth || !p.artworkHeight
  );
  if (noArtwork.length > 0) {
    throw new ValidationError(
      `Page ${noArtwork[0]!.pageNumber} has no artwork yet. Choose pages that have artwork.`
    );
  }
  const unfinishedFace = pages.filter(
    (p) => p.hasFace && (!p.maskUrl || !p.pagePrompt)
  );
  if (unfinishedFace.length > 0) {
    throw new ValidationError(
      `Page ${unfinishedFace[0]!.pageNumber} is a face page without its mask or prompt. Finish it in the comic first.`
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SAMPLE_CREATE_LOCK_KEY}))`;

    const now = new Date();
    const [liveOverall, liveForAdmin, inFlight] = await Promise.all([
      tx.orderSession.count({
        where: { isSample: true, expiresAt: { gt: now } },
      }),
      tx.orderSession.count({
        where: { isSample: true, expiresAt: { gt: now }, userId: adminId },
      }),
      tx.pageVersion.count({
        where: {
          orderSession: { isSample: true },
          status: { notIn: ["SD_READY", "FAILED"] },
        },
      }),
    ]);

    if (liveForAdmin >= MAX_LIVE_SAMPLES_PER_ADMIN) {
      throw new ConflictError(
        `You already have ${MAX_LIVE_SAMPLES_PER_ADMIN} live samples. Discard one first.`
      );
    }
    if (liveOverall >= MAX_LIVE_SAMPLES_OVERALL) {
      throw new ConflictError(
        `There are already ${MAX_LIVE_SAMPLES_OVERALL} live samples. Wait for one to expire or discard one.`
      );
    }
    if (inFlight >= MAX_SAMPLE_PAGES_IN_FLIGHT) {
      throw new ConflictError(
        "Sample pages are still being generated. Try again in a few minutes."
      );
    }

    return tx.orderSession.create({
      data: {
        comicId: input.comicId,
        userId: adminId,
        isSample: true,
        childName: input.childName,
        age: input.age,
        pronounKey: input.pronounKey,
        expiresAt: new Date(now.getTime() + SAMPLE_TTL_MS),
        sessionPages: {
          create: uniquePageIds.map((pageId) => ({
            pageId,
            isPreviewPage: true,
          })),
        },
      },
    });
  }, SAMPLE_TRANSACTION_OPTIONS);
}

/** Every sample that has not been cleaned up yet, newest first (live ones and ones waiting for cleanup). */
export async function listSamples() {
  const rows = await prisma.orderSession.findMany({
    where: { isSample: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      childName: true,
      createdAt: true,
      expiresAt: true,
      userId: true,
      comic: { select: { id: true, title: true } },
      _count: { select: { sessionPages: true } },
    },
  });

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    childName: row.childName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    createdById: row.userId,
    comic: row.comic,
    pageCount: row._count.sessionPages,
    isLive: row.expiresAt.getTime() > now,
  }));
}

/**
 * Ends a sample now: its expiry moves to the present (the ordinary expiry check then refuses new work)
 * and its page versions that are still QUEUED are deleted (the worker drops a job whose row is gone),
 * so a create-and-discard loop cannot keep spending. The files and rows are removed by the sweep.
 */
export async function discardSample(sessionId: string): Promise<void> {
  const session = await prisma.orderSession.findFirst({
    where: { id: sessionId, isSample: true },
    select: { id: true },
  });
  if (!session) {
    throw new NotFoundError("Sample not found");
  }

  await prisma.orderSession.updateMany({
    where: { id: sessionId, isSample: true, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: sessionId, status: "QUEUED" },
  });
}

// The web process also runs the workers on a small instance, so only one PDF is built at a time.
// Per process: it limits memory on each instance, not across instances.
let pdfBuildRunning = false;

/**
 * Builds the sample PDF from the chosen versions and returns the bytes. Stores nothing and writes
 * nothing to the database.
 *
 * ⚠️ The page steps (flatten on white, JPEG quality 85, page size = image size) copy
 * compilePdfForSession in session.service.ts. Change both together.
 */
export async function buildSamplePdf(
  sessionId: string,
  input: SampleSelectionsInput
): Promise<Buffer> {
  const session = await prisma.orderSession.findFirst({
    where: { id: sessionId, isSample: true },
    select: { id: true, expiresAt: true, comic: { select: { title: true } } },
  });
  if (!session) {
    throw new NotFoundError("Sample not found");
  }
  // After Discard or expiry the files are about to be deleted, so no new PDF is built.
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new ConflictError("This sample has ended.");
  }

  const pageIds = input.selections.map((s) => s.pageId);
  if (new Set(pageIds).size !== pageIds.length) {
    throw new ValidationError("Each page can be chosen only once");
  }

  const versions = await prisma.pageVersion.findMany({
    where: {
      orderSessionId: sessionId,
      id: { in: input.selections.map((s) => s.pageVersionId) },
    },
    select: {
      id: true,
      pageId: true,
      status: true,
      finalImageUrl: true,
      page: { select: { pageNumber: true } },
    },
  });

  const byId = new Map(versions.map((v) => [v.id, v]));
  const chosen = input.selections.map((selection) => {
    const version = byId.get(selection.pageVersionId);
    if (
      !version ||
      version.pageId !== selection.pageId ||
      version.status !== "SD_READY" ||
      !version.finalImageUrl
    ) {
      throw new ConflictError(
        "Every chosen version must be a finished image of this sample"
      );
    }
    // Typed as present: the guard above has just refused a missing image.
    return { ...version, finalImageUrl: version.finalImageUrl };
  });
  chosen.sort((a, b) => a.page.pageNumber - b.page.pageNumber);

  if (pdfBuildRunning) {
    throw new ConflictError(
      "Another sample PDF is being built. Try again in a moment."
    );
  }
  pdfBuildRunning = true;

  try {
    const tooLarge = () =>
      new ValidationError(
        `The PDF would be larger than ${MAX_SAMPLE_PDF_BYTES / 1024 / 1024} MB. Choose fewer pages.`
      );
    let jpegBytes = 0;
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`${session.comic.title} (sample)`);

    // One page at a time: only one image is in memory at once.
    for (const version of chosen) {
      const png = await downloadFileToBuffer(
        "public",
        getKeyFromPublicUrl(version.finalImageUrl)
      );
      const jpeg = await sharp(png)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 85 })
        .toBuffer();
      // Stop early instead of holding more and more pages in memory for a PDF that will be refused.
      jpegBytes += jpeg.length;
      if (jpegBytes > MAX_SAMPLE_PDF_BYTES) throw tooLarge();
      const { width, height } = await sharp(jpeg).metadata();
      if (!width || !height) {
        throw new ConflictError(
          `Could not read the size of page ${version.page.pageNumber}`
        );
      }
      const image = await pdfDoc.embedJpg(jpeg);
      pdfDoc.addPage([width, height]).drawImage(image, {
        x: 0,
        y: 0,
        width,
        height,
      });
    }

    const bytes = Buffer.from(await pdfDoc.save());
    if (bytes.length > MAX_SAMPLE_PDF_BYTES) throw tooLarge();
    logger.info(
      { sessionId, pageCount: chosen.length, byteSize: bytes.length },
      "Sample PDF built"
    );
    return bytes;
  } finally {
    pdfBuildRunning = false;
  }
}
