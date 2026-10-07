import { prisma } from "../lib/prisma.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import type {
  CreateSessionInput,
  UpdateSessionInput,
} from "../validators/session.schema.js";
import { Prisma } from "../generated/prisma/client.js";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { downloadFileToBuffer, getKeyFromPublicUrl,  uploadFile, getPublicUrl, getSignedUploadUrl } from "../lib/r2.js";
import { shiprocketQueue } from "../jobs/queues.js";
import type {
  OrderSession,
  OrderSessionStatus,
} from "../generated/prisma/client.js";
import { sdGenerationQueue } from "../jobs/queues.js";
import {
  MAX_VARIANTS_BEFORE_PAYMENT,
  MAX_VARIANTS_AFTER_PAYMENT,
} from "../config/generation.js";
import { pdfCompilationQueue } from "../jobs/queues.js";
import type { SendToPrintInput } from "../validators/sendToPrint.schema.js";
import { notifySentToPrint } from "./notification.service.js";

/**
 * Statuses meaning "the customer has paid."
 * Used by regeneratePage to decide the variant cap.
 */
export const POST_PAYMENT_STATUSES: OrderSessionStatus[] = [
  "PAID",
  "GENERATING_PAID",
  "PAID_PAGES_READY",
  "CONFIRMED",
];

/**
 * How long an unpaid session lives, counted from creation. Written once into
 * `OrderSession.expiresAt` by createOrderSession and never extended, so a change
 * here applies to new sessions only.
 *
 * ⚠️ The frontend carries its own copy of this window — the localStorage TTL in
 * `app/lib/session-storage.ts` and the "Previews are kept for…" message on the
 * preview page. Two repos, so change all three together.
 */
const SESSION_LIFETIME_DAYS = 7;
const SESSION_LIFETIME_MS = SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

/**
 * Statuses that are exempt from session expiry.
 * Includes AWAITING_PAYMENT (customer is at the Razorpay modal — don't kill
 * their session mid-payment) plus every status after payment (per the locked
 * decision: no expiry after payment).
 *
 * The post-send-to-print statuses are listed here explicitly rather than added
 * to POST_PAYMENT_STATUSES, because that list also drives the regeneration cap
 * and the post-payment field lock. Without them, a printed book's session
 * expired like an unpaid one: the customer's "View your book" link showed
 * "expired", and the hourly sweeper overwrote PDF_FAILED / SHIPMENT_FAILED
 * with a plain FAILED, losing which step had failed.
 */
export const EXPIRY_EXEMPT_STATUSES: OrderSessionStatus[] = [
  "AWAITING_PAYMENT",
  ...POST_PAYMENT_STATUSES,
  "COMPILING_PDF",
  "PDF_FAILED",
  "SHIPMENT_QUEUED",
  "SHIPMENT_FAILED",
  "COMPLETED",
];

/** BullMQ's hard ceiling on `priority` (2^21 − 1). Anything above throws on add. */
const MAX_BULLMQ_PRIORITY = 2_097_151;

/**
 * BullMQ priority for one page job: the page number itself.
 *
 * Lower runs first, and BullMQ breaks ties in insertion order (FIFO). So every
 * session's page 1 runs before anyone's page 2, and on the same page number the
 * session that queued first wins — books advance side by side instead of one
 * customer's whole book blocking the next.
 *
 * Replaces `secondsInDay + pageNumber * 80_000`, which assumed ≤ 24 pages:
 * page 26 crossed the 21-bit ceiling for most of the day and page 27+ always
 * did, so every page past 25 threw "Priority should be between 0 and 2097152"
 * and a 49-page book could never finish. It also mis-ordered sessions across
 * the midnight-UTC wrap.
 */
function computeJobPriority(pageNumber: number): number {
  return Math.min(Math.max(pageNumber, 1), MAX_BULLMQ_PRIORITY);
}

/** States in which a job is still going to run — re-adding it would duplicate work. */
const LIVE_JOB_STATES = new Set([
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/**
 * Of the given reused PageVersion rows, return the ids that still need a job.
 *
 * Every page job uses `jobId = pageVersionId`, so BullMQ ignores a second add of
 * the same page — that is what stops a webhook retry from generating (and paying
 * RunPod for) the same page twice. The catch: BullMQ keeps finished jobs around
 * (completed 24h, failed 7 days, see queues.ts), and an add whose jobId matches a
 * finished job is ALSO silently ignored. A row being re-queued after a failure
 * would then never run. So:
 *   - live job (waiting / active / …)  → skip, it is already queued
 *   - finished job (completed / failed) → remove it so the new add goes through
 *   - no job                            → needs one
 *
 * Only reused rows can have an old job; freshly created rows have brand-new ids.
 */
async function filterRowsNeedingJobs(rowIds: string[]): Promise<Set<string>> {
  const needed = new Set<string>();

  await Promise.all(
    rowIds.map(async (id) => {
      const existing = await sdGenerationQueue.getJob(id);
      if (!existing) {
        needed.add(id);
        return;
      }

      const state = await existing.getState();
      if (LIVE_JOB_STATES.has(state)) return;

      await existing.remove();
      needed.add(id);
    })
  );

  return needed;
}

/**
 * Add one generation job per row in a SINGLE Redis call.
 *
 * `addBulk` instead of N parallel `add`s: one round trip rather than a burst,
 * and the batch goes in whole or not at all — the parallel version left books
 * half-queued when some adds threw and others had already landed.
 */
async function addPageJobs(
  rows: { pageVersionId: string; pageNumber: number }[]
): Promise<void> {
  if (rows.length === 0) return;

  await sdGenerationQueue.addBulk(
    rows.map((row) => ({
      name: "generate-page",
      data: { pageVersionId: row.pageVersionId },
      opts: {
        jobId: row.pageVersionId,
        priority: computeJobPriority(row.pageNumber),
      },
    }))
  );
}
/**
 * Throws if the session is past expiresAt; also flips it to FAILED so future reads
 * are clean. Audit 11.1.
 *
 * Exported and shared with `checkout.service.ts`. It used to be duplicated there,
 * and the copy silently lost the `expiresAt` comparison below — which made
 * `initiateCheckout` flip EVERY non-exempt session to FAILED and report it as
 * expired, however new it was. Do not re-copy this function; import it.
 */
export async function assertNotExpired(session: {
  id: string;
  expiresAt: Date;
  status: OrderSessionStatus;
}): Promise<void> {
  // Paid sessions (and sessions mid-payment) are exempt from expiry.
  // Decision: no expiry after payment; session lives until send-to-print.
  if (EXPIRY_EXEMPT_STATUSES.includes(session.status)) return;
  if (session.expiresAt >= new Date()) return;

  // Already terminal — don't rewrite the row, just refuse the mutation.
  const TERMINAL_STATUSES: OrderSessionStatus[] = ["FAILED", "COMPLETED"];
  if (TERMINAL_STATUSES.includes(session.status)) {
    throw new ConflictError("This session has expired.");
  }

  // Atomic flip via updateMany + status guard — safe against concurrent callers.
  await prisma.orderSession.updateMany({
    where: {
      id: session.id,
      status: { notIn: TERMINAL_STATUSES },
    },
    data: { status: "FAILED" },
  });

  logger.warn(
    { sessionId: session.id, expiredAt: session.expiresAt },
    "Session expired on mutation attempt — flipped to FAILED"
  );

  throw new ConflictError("This session has expired.");
}

/** Hourly sweeper — flips every non-terminal expired session to FAILED. R2 cleanup is not done here (out of scope). */
export async function sweepExpiredSessions(): Promise<number> {
  const { count } = await prisma.orderSession.updateMany({
    where: {
      expiresAt: { lt: new Date() },
      status: {
        notIn: ["FAILED", "COMPLETED", ...EXPIRY_EXEMPT_STATUSES],
      },
    },
    data: { status: "FAILED" },
  });

  if (count > 0) {
    logger.info(
      { expiredCount: count },
      "[Expiry Sweeper] Flipped expired sessions to FAILED"
    );
  }

  return count;
}
export async function createOrderSession(
  input: CreateSessionInput,
  userId?: string
) {
  const comic = await prisma.comic.findUnique({ where: { id: input.comicId } });

  if (!comic || comic.status !== "PUBLISHED") {
    throw new NotFoundError("Comic not found");
  }

  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  return prisma.orderSession.create({
    data: {
      comicId: input.comicId,
      userId: userId ?? null,
      expiresAt,
    },
  });
}

export async function updateOrderSession(
  sessionId: string,
  input: UpdateSessionInput
) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  // Post-payment lock: once the customer has paid (or is at the Razorpay modal),
  // these fields are frozen. childName/pronounKey/age are baked into the paid
  // images, coverType was priced at checkout, shipping was snapshotted onto the
  // Order row. notificationEmail stays editable — it's never printed.
  const isLocked =
    session.status === "AWAITING_PAYMENT" ||
    POST_PAYMENT_STATUSES.includes(session.status);

  if (isLocked) {
    const lockedFields: (keyof UpdateSessionInput)[] = [
      "childName",
      "age",
      "pronounKey",
      "coverType",
      "shippingName",
      "shippingLine1",
      "shippingLine2",
      "shippingCity",
      "shippingState",
      "shippingZip",
      "shippingCountry",
      "shippingPhone",
    ];

    const attemptedLockedEdits = lockedFields.filter(
      (field) => input[field] !== undefined
    );

    if (attemptedLockedEdits.length > 0) {
      throw new ConflictError(
        `Cannot edit ${attemptedLockedEdits.join(", ")} — session is at status ${session.status} and these fields are locked at checkout. Only notificationEmail can be updated.`
      );
    }
  }

  const data: Prisma.OrderSessionUpdateInput = {};
  if (input.childName !== undefined) data.childName = input.childName;
  if (input.age !== undefined) data.age = input.age;
  if (input.pronounKey !== undefined) data.pronounKey = input.pronounKey;
  if (input.notificationEmail !== undefined)
    data.notificationEmail = input.notificationEmail;
  if (input.coverType !== undefined) data.coverType = input.coverType;
  if (input.shippingName !== undefined) data.shippingName = input.shippingName;
  if (input.shippingLine1 !== undefined)
    data.shippingLine1 = input.shippingLine1;
  if (input.shippingLine2 !== undefined)
    data.shippingLine2 = input.shippingLine2;
  if (input.shippingCity !== undefined) data.shippingCity = input.shippingCity;
  if (input.shippingState !== undefined)
    data.shippingState = input.shippingState;
  if (input.shippingZip !== undefined) data.shippingZip = input.shippingZip;
  if (input.shippingCountry !== undefined)
    data.shippingCountry = input.shippingCountry;
  if (input.shippingPhone !== undefined)
    data.shippingPhone = input.shippingPhone;

  return prisma.orderSession.update({
    where: { id: sessionId },
    data,
  });
}

export const getOrderSessionId = async (sessionId: string) => {
  // Fetch the session itself (with comic metadata we'll need)
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: {
      comic: {
        select: {
          id: true,
          title: true,
          freePreviewPages: true,
          coverThumbnailUrls: true,
        },
      },
    },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  // Fetch all pages of the comic (not just preview ones). Frontend needs
  // the full book structure to render locked pages with a paywall overlay.
  //
  // artworkUrl is returned for EVERY page, including locked ones, so the
  // paywall can show the real page blurred behind it rather than a blank box.
  // That is a deliberate, cosmetic-only paywall: a client can read the URL out
  // of this response and fetch the unblurred art. It rests on the existing
  // position that blank-bubble artwork — no face swap, no personalisation — is
  // not the sellable product. Preview-page artwork was already public via
  // GET /api/public/comics/:id; this widens that to the whole book.
  //
  // The dimensions travel with it so the client can reserve the correct
  // aspect-ratio box for a locked page instead of guessing at a square.
  const allPages = await prisma.page.findMany({
    where: { comicId: session.comicId },
    orderBy: { pageNumber: "asc" },
    select: {
      id: true,
      pageNumber: true,
      isPreviewPage: true,
      hasFace: true,
      artworkUrl: true,
      artworkWidth: true,
      artworkHeight: true,
    },
  });

  // Fetch every PageVersion for this session — includes all variants of
  // all pages that have been generated (or attempted) so far.
  const pageVersions = await prisma.pageVersion.findMany({
    where: { orderSessionId: sessionId },
    orderBy: { variantIndex: "asc" },
    select: {
      id: true,
      pageId: true,
      variantIndex: true,
      status: true,
      finalImageUrl: true,
      displayImageUrl: true,
      isSelected: true,
      errorMessage: true,
    },
  });

  // Group PageVersions by pageId so we can nest them under each page below.
  // Map<pageId, PageVersion[]>. Constructing this once is O(n); doing
  // .filter() per page below would be O(n²).
  const versionsByPageId = new Map<string, typeof pageVersions>();
  for (const pv of pageVersions) {
    const existing = versionsByPageId.get(pv.pageId);
    if (existing) {
      existing.push(pv);
    } else {
      versionsByPageId.set(pv.pageId, [pv]);
    }
  }

  // Shape each page with its variants nested underneath.
  const pages = allPages.map((page) => {
    const variants = (versionsByPageId.get(page.id) ?? []).map((pv) => ({
      pageVersionId: pv.id,
      variantIndex: pv.variantIndex,
      status: pv.status,
      // finalImageUrl is the print master (multi-MB PNG); displayImageUrl is the
      // web derivative and is what clients should render. Null on rows generated
      // before the derivative existed, or where building it failed — fall back
      // to finalImageUrl in that case.
      finalImageUrl: pv.finalImageUrl,
      displayImageUrl: pv.displayImageUrl,
      isSelected: pv.isSelected,
      errorMessage: pv.errorMessage,
    }));

    return {
      pageId: page.id,
      pageNumber: page.pageNumber,
      isPreviewPage: page.isPreviewPage,
      hasFace: page.hasFace,
      // Null until the admin attaches artwork — clients must fall back rather
      // than assume a URL is present.
      artworkUrl: page.artworkUrl,
      artworkWidth: page.artworkWidth,
      artworkHeight: page.artworkHeight,
      variants,
    };
  });

  // Exempt statuses (AWAITING_PAYMENT + post-payment) are never treated
  // as expired, matching assertNotExpired and sweepExpiredSessions.
  const isExpired =
    session.expiresAt < new Date() &&
    !EXPIRY_EXEMPT_STATUSES.includes(session.status);

  return {
    id: session.id,
    comicId: session.comicId,
    userId: session.userId,
    childName: session.childName,
    pronounKey: session.pronounKey,
    age: session.age,
    notificationEmail: session.notificationEmail,
    coverType: session.coverType,
    status: session.status,
    bestPhotoUrl: session.bestPhotoUrl,
    shippingName: session.shippingName,
    shippingLine1: session.shippingLine1,
    shippingLine2: session.shippingLine2,
    shippingCity: session.shippingCity,
    shippingState: session.shippingState,
    shippingZip: session.shippingZip,
    shippingCountry: session.shippingCountry,
    shippingPhone: session.shippingPhone,
    wsRoomToken: session.wsRoomToken,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    isExpired,
    comic: session.comic,
    pages,
  };
};

const EXTENSION_TO_CONTENT_TYPE: Record<
  "jpg" | "jpeg" | "png" | "webp",
  string
> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const PHOTO_UPLOAD_EXPIRY_SECONDS = 5 * 60; // 5 minutes — plenty of time for a direct browser upload

// Both photo endpoints gate on this same list: CREATED is the first upload,
// PHOTO_UPLOADED is the user swapping in a better photo before generation
// starts. Kept as ONE constant precisely because the two halves drifted apart
// once — confirm was widened to allow re-uploads while upload-url stayed at
// CREATED only, which made re-upload unreachable from the frontend.
const PHOTO_MUTABLE_STATUSES: OrderSessionStatus[] = [
  "CREATED",
  "PHOTO_UPLOADED",
];

export async function createPhotoUploadUrl(
  sessionId: string,
  fileExtension: "jpg" | "jpeg" | "png" | "webp"
) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  if (!PHOTO_MUTABLE_STATUSES.includes(session.status)) {
    throw new ConflictError(
      `Photo upload is only allowed before generation starts. Current status: ${session.status}`
    );
  }

  const key = `sessions/${sessionId}/photo-${Date.now()}.${fileExtension}`;
  const contentType = EXTENSION_TO_CONTENT_TYPE[fileExtension];

  const uploadUrl = await getSignedUploadUrl(
    "private",
    key,
    contentType,
    PHOTO_UPLOAD_EXPIRY_SECONDS
  );

  return { uploadUrl, key };
}

export async function confirmSessionPhoto(sessionId: string, key: string) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  if (!PHOTO_MUTABLE_STATUSES.includes(session.status)) {
    throw new ConflictError(
      `Photo confirm is only allowed before generation starts. Current status: ${session.status}`
    );
  }
  // Audit 8.2 — key ownership check. Rejects keys from other sessions'
  // folders (or malformed paths) before writing to the DB.
  const expectedPrefix = `sessions/${sessionId}/`;
  if (!key.startsWith(expectedPrefix)) {
    logger.warn(
      { sessionId, key },
      "confirmSessionPhoto: rejected key from outside this session's folder"
    );
    throw new ValidationError(
      "The provided key does not belong to this session."
    );
  }

  const updatedSession = await prisma.orderSession.update({
    where: { id: sessionId },
    data: {
      rawPhotoUrls: [key],
      bestPhotoUrl: key,
      status: "PHOTO_UPLOADED",
    },
  });

  return { session: updatedSession };
}

interface CompletenessResult {
  isComplete: boolean;
  missingFields: string[];
}

function isSessionCompleteForGeneration(
  session: OrderSession
): CompletenessResult {
  const missingFields: string[] = [];

  if (session.childName === null) missingFields.push("childName");
  if (session.age === null) missingFields.push("age");
  if (session.pronounKey === null) missingFields.push("pronounKey");
  if (session.bestPhotoUrl === null) missingFields.push("photo");

  return {
    isComplete: missingFields.length === 0,
    missingFields,
  };
}

async function enqueuePreviewGenerationJobs(
  orderSessionId: string,
  comicId: string,
  freePreviewPages: number
): Promise<number> {
  // STEP 1: Find the pages that are explicitly marked as preview pages.
  //
  // `isPreviewPage` is the source of truth — the admin picks WHICH pages
  // are free (could be any subset, not necessarily the first N). The
  // `freePreviewPages` counter on Comic is just metadata; we use it below
  // only as a sanity check for data-integrity drift.
  const previewPages = await prisma.page.findMany({
    where: { comicId, isPreviewPage: true },
    orderBy: { pageNumber: "asc" },
  });

  if (previewPages.length === 0) {
    logger.warn(
      { orderSessionId, comicId },
      "enqueuePreviewGenerationJobs: comic has no preview pages"
    );
    return 0;
  }

  // Sanity check: the counter on Comic should match the number of pages
  // flagged as preview. Frontend enforces this on publish, but a manual
  // DB edit could break it. Log-only, don't fail — the truth is `isPreviewPage`.
  if (previewPages.length !== freePreviewPages) {
    logger.warn(
      {
        orderSessionId,
        comicId,
        expected: freePreviewPages,
        actual: previewPages.length,
      },
      "enqueuePreviewGenerationJobs: Comic.freePreviewPages counter does not match the number of pages with isPreviewPage=true"
    );
  }

  // Step 2: Recover any rows left behind by a previous failed attempt.
  //
  // Rows are committed to Postgres BEFORE anything is written to Redis, so a
  // Redis outage leaves QUEUED rows with no job to ever pick them up. Those
  // rows occupy @@unique([orderSessionId, pageId, variantIndex]), so blindly
  // creating fresh ones on retry throws P2002 and the session can never
  // recover. Reuse what already exists; create only what is missing.
  const existingRows = await prisma.pageVersion.findMany({
    where: {
      orderSessionId,
      variantIndex: 0,
      pageId: { in: previewPages.map((page) => page.id) },
    },
  });

  const existingPageIds = new Set(existingRows.map((row) => row.pageId));
  const pagesNeedingRows = previewPages.filter(
    (page) => !existingPageIds.has(page.id)
  );

  if (existingRows.length > 0) {
    logger.info(
      {
        orderSessionId,
        reused: existingRows.length,
        created: pagesNeedingRows.length,
      },
      "enqueuePreviewGenerationJobs: reusing PageVersion rows from a prior failed attempt"
    );
  }

  // Step 3: Create the missing rows atomically.
  // If any INSERT fails, none of them persist — user retries cleanly.
  const createdRows =
    pagesNeedingRows.length > 0
      ? await prisma.$transaction(
          pagesNeedingRows.map((page) =>
            prisma.pageVersion.create({
              data: {
                orderSessionId,
                pageId: page.id,
                variantIndex: 0,
                status: "QUEUED",
              },
            })
          )
        )
      : [];

  // Step 4: Work out which rows actually need a job.
  //
  // A reused row that already reached SD_READY is finished — re-queueing it
  // would only make the worker re-emit page:ready for no reason. A reused row
  // whose job is still live in Redis is already being handled — re-queueing it
  // would generate the page twice. Everything else (QUEUED orphans, FAILED
  // rows, rows stranded mid-pipeline) gets reset to QUEUED so the DB reflects
  // that they are waiting again.
  const createdIds = new Set(createdRows.map((row) => row.id));
  const unfinishedRows = [...existingRows, ...createdRows].filter(
    (row) => row.status !== "SD_READY"
  );

  const reusedNeedingJobs = await filterRowsNeedingJobs(
    unfinishedRows.filter((row) => !createdIds.has(row.id)).map((row) => row.id)
  );

  const rowsToEnqueue = unfinishedRows.filter(
    (row) => createdIds.has(row.id) || reusedNeedingJobs.has(row.id)
  );

  const staleRowIds = rowsToEnqueue
    .filter((row) => row.status !== "QUEUED")
    .map((row) => row.id);

  if (staleRowIds.length > 0) {
    await prisma.pageVersion.updateMany({
      where: { id: { in: staleRowIds } },
      data: { status: "QUEUED", errorMessage: null },
    });
  }

  // Step 5: Enqueue BullMQ jobs — one per row, with priority, in one call.
  // Runs AFTER all DB writes commit, so a Redis failure here can't
  // orphan the DB rows in an inconsistent state.
  //
  // Pairing is by pageId lookup rather than array index: existing and created
  // rows come from two different queries, so positional pairing against
  // previewPages would silently attach the wrong priority to the wrong page.
  const pageById = new Map(previewPages.map((page) => [page.id, page]));

  await addPageJobs(
    rowsToEnqueue.map((row) => ({
      pageVersionId: row.id,
      pageNumber: pageById.get(row.pageId)!.pageNumber,
    }))
  );

  logger.info(
    {
      orderSessionId,
      jobCount: rowsToEnqueue.length,
      alreadyQueued: unfinishedRows.length - rowsToEnqueue.length,
    },
    "Preview generation jobs enqueued"
  );

  return rowsToEnqueue.length;
}

const GENERATABLE_STATUSES: OrderSessionStatus[] = [
  "CREATED",
  "PHOTO_UPLOADED",
];

export async function triggerGeneration(sessionId: string) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: { comic: true },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  if (!GENERATABLE_STATUSES.includes(session.status)) {
    throw new ConflictError(
      `Cannot trigger generation — session status is already '${session.status}'`
    );
  }

  const { isComplete, missingFields } = isSessionCompleteForGeneration(session);

  if (!isComplete) {
    throw new ValidationError(
      `Session is missing required fields: ${missingFields.join(", ")}`
    );
  }

  const jobsEnqueued = await enqueuePreviewGenerationJobs(
    sessionId,
    session.comicId,
    session.comic.freePreviewPages
  );

  await prisma.orderSession.update({
    where: { id: sessionId },
    data: { status: "GENERATING_PREVIEW" },
  });

  return { status: "GENERATING_PREVIEW" as const, jobsEnqueued };
}

const REGENERATABLE_STATUSES: OrderSessionStatus[] = [
  "GENERATING_PREVIEW",
  "PREVIEW_READY",
  "GENERATING_PAID",
  "PAID_PAGES_READY",
  "FAILED",
];

export async function regeneratePage(sessionId: string, pageNumber: number) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  const page = await prisma.page.findUnique({
    where: { comicId_pageNumber: { comicId: session.comicId, pageNumber } },
  });

  if (!page) {
    throw new NotFoundError(`Page ${pageNumber} does not exist for this comic`);
  }

  if (!REGENERATABLE_STATUSES.includes(session.status)) {
    throw new ConflictError(
      `Cannot regenerate — session is not in an active generation stage (current status: ${session.status})`
    );
  }

  const hasPaid = POST_PAYMENT_STATUSES.includes(session.status);
  const cap = hasPaid
    ? MAX_VARIANTS_AFTER_PAYMENT
    : MAX_VARIANTS_BEFORE_PAYMENT;

  // Count + cap check + row creation all in one transaction.
  // Prevents variantIndex races if the user double-clicks regenerate.

  const newRow = await prisma.$transaction(async (tx) => {
    const existingVariantCount = await tx.pageVersion.count({
      where: { orderSessionId: sessionId, pageId: page.id },
    });

    if (existingVariantCount >= cap) {
      throw new ConflictError(
        `Maximum regenerations (${cap}) already reached for page ${pageNumber}`
      );
    }

    return tx.pageVersion.create({
      data: {
        orderSessionId: sessionId,
        pageId: page.id,
        variantIndex: existingVariantCount,
        status: "QUEUED",
      },
    });
  });

  // A FAILED session is regeneratable, but maybeMarkPreviewComplete only flips
  // sessions that are currently GENERATING_PREVIEW. Without moving the session
  // back first, a successful regeneration would write SD_READY on the page and
  // leave the session stuck at FAILED forever.
  //
  // This runs BEFORE the enqueue on purpose: the worker has concurrency 5 and
  // picks jobs up immediately, so flipping afterwards would race a fast page
  // finishing, no-opping the guard, and stranding the session the other way.
  //
  // updateMany + status guard makes concurrent regenerations safe — the second
  // one matches zero rows and no-ops. No rollback if the enqueue below throws:
  // GENERATING_PREVIEW is itself regeneratable, so the user retrying re-enters
  // the normal path, and a rollback would race a sibling regeneration that did
  // enqueue successfully.
  if (session.status === "FAILED") {
    const { count } = await prisma.orderSession.updateMany({
      where: { id: sessionId, status: "FAILED" },
      data: { status: "GENERATING_PREVIEW" },
    });

    if (count > 0) {
      logger.info(
        { sessionId, pageNumber },
        "Session moved FAILED → GENERATING_PREVIEW to accept a regeneration"
      );
    }
  }

  await addPageJobs([
    { pageVersionId: newRow.id, pageNumber: page.pageNumber },
  ]);

  logger.info(
    { sessionId, pageNumber, variantIndex: newRow.variantIndex },
    "Page regeneration job enqueued"
  );

  return {
    queued: true,
    pageNumber,
    variantIndex: newRow.variantIndex,
    hasPaid,
  };
}

export async function attachUserToSession(sessionId: string, userId: string) {
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError("OrderSession not found");
  }

  await assertNotExpired(session);

  if (session.userId === userId) {
    return session;
  }

  if (session.userId !== null) {
    throw new ConflictError("Session already belongs to another user");
  }

  return prisma.orderSession.update({
    where: { id: sessionId },
    data: { userId },
  });
}

async function enqueuePaidGenerationJobs(
  orderSessionId: string,
  comicId: string
): Promise<number> {
  // Paid pages = every page NOT flagged as preview.
  const paidPages = await prisma.page.findMany({
    where: { comicId, isPreviewPage: false },
    orderBy: { pageNumber: "asc" },
  });

  if (paidPages.length === 0) {
    logger.warn(
      { orderSessionId, comicId },
      "enqueuePaidGenerationJobs: comic has no paid pages"
    );
    return 0;
  }

  // Orphan-row recovery — same reasoning as preview: a Redis outage
  // during a previous attempt can leave QUEUED rows the worker never picks up.
  const existingRows = await prisma.pageVersion.findMany({
    where: {
      orderSessionId,
      variantIndex: 0,
      pageId: { in: paidPages.map((page) => page.id) },
    },
  });

  const existingPageIds = new Set(existingRows.map((row) => row.pageId));
  const pagesNeedingRows = paidPages.filter(
    (page) => !existingPageIds.has(page.id)
  );

  if (existingRows.length > 0) {
    logger.info(
      {
        orderSessionId,
        reused: existingRows.length,
        created: pagesNeedingRows.length,
      },
      "enqueuePaidGenerationJobs: reusing PageVersion rows from a prior attempt"
    );
  }

  const createdRows =
    pagesNeedingRows.length > 0
      ? await prisma.$transaction(
          pagesNeedingRows.map((page) =>
            prisma.pageVersion.create({
              data: {
                orderSessionId,
                pageId: page.id,
                variantIndex: 0,
                status: "QUEUED",
              },
            })
          )
        )
      : [];

  // Same selection as the preview path — see its Step 4 for the reasoning.
  // On a Razorpay webhook retry this is what stops pages that are still
  // queued from the first attempt being generated a second time.
  const createdIds = new Set(createdRows.map((row) => row.id));
  const unfinishedRows = [...existingRows, ...createdRows].filter(
    (row) => row.status !== "SD_READY"
  );

  const reusedNeedingJobs = await filterRowsNeedingJobs(
    unfinishedRows.filter((row) => !createdIds.has(row.id)).map((row) => row.id)
  );

  const rowsToEnqueue = unfinishedRows.filter(
    (row) => createdIds.has(row.id) || reusedNeedingJobs.has(row.id)
  );

  const staleRowIds = rowsToEnqueue
    .filter((row) => row.status !== "QUEUED")
    .map((row) => row.id);

  if (staleRowIds.length > 0) {
    await prisma.pageVersion.updateMany({
      where: { id: { in: staleRowIds } },
      data: { status: "QUEUED", errorMessage: null },
    });
  }

  const pageById = new Map(paidPages.map((page) => [page.id, page]));

  await addPageJobs(
    rowsToEnqueue.map((row) => ({
      pageVersionId: row.id,
      pageNumber: pageById.get(row.pageId)!.pageNumber,
    }))
  );

  logger.info(
    {
      orderSessionId,
      jobCount: rowsToEnqueue.length,
      alreadyQueued: unfinishedRows.length - rowsToEnqueue.length,
    },
    "Paid generation jobs enqueued"
  );

  return rowsToEnqueue.length;
}

// Export so webhook service can call it.
export { enqueuePaidGenerationJobs };

type PaidReadyResult = "not-done" | "ready" | "failed";

export async function maybeMarkPaidReady(
  orderSessionId: string,
  comicId: string
): Promise<PaidReadyResult> {
  // Paid pages = every Page for the comic that is NOT a free preview page.
  // Same filter enqueuePaidGenerationJobs uses.
  const totalPaidPages = await prisma.page.count({
    where: { comicId, isPreviewPage: false },
  });

  // No paid pages configured for this comic means nothing was enqueued.
  // Never flip.
  if (totalPaidPages === 0) return "not-done";

  // Every terminal PageVersion row for this session's paid pages. Same shape
  // as the preview helper — deliberately NOT distinct on pageId because a
  // page can hold a failed attempt + a successful regeneration and both
  // matter for the "did ANY variant succeed" question.
  const terminalRows = await prisma.pageVersion.findMany({
    where: {
      orderSessionId,
      status: { in: ["SD_READY", "FAILED"] },
      page: { isPreviewPage: false },
    },
    select: { pageId: true, status: true },
  });

  const terminalPageIds = new Set<string>();
  const succeededPageIds = new Set<string>();

  for (const row of terminalRows) {
    terminalPageIds.add(row.pageId);
    if (row.status === "SD_READY") succeededPageIds.add(row.pageId);
  }

  // Not every paid page has settled yet — nothing to do.
  if (terminalPageIds.size < totalPaidPages) return "not-done";

  // Success-wins: any single SD_READY page keeps the session recoverable
  // (customer can regenerate the failed pages individually).
  const anySuccess = succeededPageIds.size > 0;
  const targetStatus = anySuccess ? "PAID_PAGES_READY" : "FAILED";

  // Two rows must move together (Session + Order on success). Wrap in a
  // transaction so a partial flip is impossible. No Redis enqueues inside —
  // per DECISIONS, Redis calls never live inside $transaction.
  const flipped = await prisma.$transaction(async (tx) => {
    const { count } = await tx.orderSession.updateMany({
      where: {
        id: orderSessionId,
        status: "GENERATING_PAID", // guard is IN the query
      },
      data: { status: targetStatus },
    });

    // Someone else already flipped it — bail out of the transaction with
    // no Order flip. Their transaction did (or will do) the Order flip.
    if (count === 0) return false;

    // Only flip the Order on the success branch. On all-failure we leave
    // Order at PAID for admin review (see block comment above).
    if (anySuccess) {
      await tx.order.updateMany({
        where: { orderSessionId, status: "PAID" },
        data: { status: "GENERATED" },
      });
    }

    return true;
  });

  if (!flipped) return "not-done";

  return anySuccess ? "ready" : "failed";
}

// ============================================================================
// SEND-TO-PRINT
// ============================================================================

/**
 * Commit the customer's variant selections, lock the session, and enqueue
 * PDF compilation. Idempotent: a second call at CONFIRMED just re-enqueues
 * the PDF job without touching selections or status.
 *
 * Flow:
 *  1. Fetch session + guards (exists, owned by user, correct status).
 *  2. If already CONFIRMED — jump to enqueue path (idempotent retry).
 *  3. Fetch comic (need pageCount) and validate selection count.
 *  4. Fetch every referenced PageVersion + check no in-flight variants exist.
 *  5. Transaction: mark selected variants isSelected=true, flip Session to
 *     CONFIRMED, flip Order to CONFIRMED.
 *  6. Enqueue PDF compilation OUTSIDE the transaction. Job ID = sessionId
 *     for BullMQ dedupe (a second call replaces, not duplicates).
 */

export async function sendToPrint(
  sessionId: string,
  userId: string,
  input: SendToPrintInput
) {
  // 1. fetch session with everything we need
  const session = await prisma.orderSession.findUnique({
    where: { id: sessionId },
    include: {
      order: true,
      comic: { select: { id: true, pageCount: true } },
    },
  });

  if (!session) {
    throw new NotFoundError("Session not found");
  }

  // Ownership check - mirrors the pattern in the getUserOrder
  if (session.userId !== userId) {
    throw new ForbiddenError(
      "You do not have permission to send this session to print"
    );
  }

  if (!session.order) {
    // Should be impossible — session at PAID_PAGES_READY/CONFIRMED must have
    // an Order row. Log and reject rather than crash.
    logger.error(
      { sessionId, status: session.status },
      "sendToPrint: session has no Order row despite post-payment status"
    );
    throw new ConflictError("Session has no associated order");
  }

  // 2. Idempotent retry path — session already CONFIRMED.
  // Just re-enqueue the PDF job (BullMQ dedupes on jobId) and return.

  if (session.status === "CONFIRMED") {
    logger.info(
      { sessionId, orderId: session.order.id },
      "sendToPrint called on already-CONFIRMED session — re-enqueuing PDF job"
    );

    await pdfCompilationQueue.add(
      "compile-pdf",
      { orderSessionId: sessionId },
      { jobId: sessionId } // dedupe key
    );
    return {
      sessionId,
      orderId: session.order.id,
      status: "CONFIRMED" as const,
      pdfCompilationEnqueued: true,
    };
  }

  // Status guard — everything else is a hard reject.
  if (session.status !== "PAID_PAGES_READY") {
    throw new ConflictError(
      `Session must be at PAID_PAGES_READY to send to print. Current: ${session.status}`
    );
  }

  // 3. Selection count must match total pages in the comic.
  if (input.selections.length !== session.comic.pageCount) {
    throw new ValidationError(
      `Expected ${session.comic.pageCount} selections, got ${input.selections.length}`
    );
  }

  // 4a. Reject if any PageVersion for this session is mid-generation.
  // Non-terminal statuses are anything other than SD_READY / FAILED.
  const inFlight = await prisma.pageVersion.findFirst({
    where: {
      orderSessionId: sessionId,
      status: { notIn: ["SD_READY", "FAILED"] },
    },
    select: { id: true, page: { select: { pageNumber: true } } },
  });

  if (inFlight) {
    throw new ConflictError(
      `Cannot send to print: page ${inFlight.page.pageNumber} has a variant still generating. Please wait for it to finish.`
    );
  }

  // 4b. Fetch every referenced PageVersion in one query, then match against
  // the incoming selections. Cheaper than N per-selection lookups.
  const selectedPageNumbers = input.selections.map((s) => s.pageNumber);

  const pageVersions = await prisma.pageVersion.findMany({
    where: {
      orderSessionId: sessionId,
      page: { pageNumber: { in: selectedPageNumbers } },
    },
    select: {
      id: true,
      variantIndex: true,
      status: true,
      pageId: true,
      page: { select: { pageNumber: true } },
    },
  });

  // Build a lookup: "pageNumber:variantIndex" -> PageVersion
  const versionMap = new Map<string, (typeof pageVersions)[number]>();
  for (const pv of pageVersions) {
    versionMap.set(`${pv.page.pageNumber}:${pv.variantIndex}`, pv);
  }

  // Resolve each selection to a PageVersion id, rejecting missing / not-ready.
  const selectedVersionIds: string[] = [];

  for (const sel of input.selections) {
    const pv = versionMap.get(`${sel.pageNumber}:${sel.variantIndex}`);

    if (!pv) {
      throw new ValidationError(
        `No variant found for page ${sel.pageNumber} variant ${sel.variantIndex}`
      );
    }

    if (pv.status !== "SD_READY") {
      throw new ValidationError(
        `Page ${sel.pageNumber} variant ${sel.variantIndex} is not ready (status: ${pv.status})`
      );
    }

    selectedVersionIds.push(pv.id);
  }

  // 5. Transaction — commit selections + flip both status rows atomically.
  // Guards live IN the queries so a concurrent send-to-print can't race us.
  const orderId = session.order.id;

  await prisma.$transaction(async (tx) => {
    // Mark chosen variants
    await tx.pageVersion.updateMany({
      where: { id: { in: selectedVersionIds } },
      data: { isSelected: true },
    });

    // Flip session — guard on PAID_PAGES_READY
    const sessionFlip = await tx.orderSession.updateMany({
      where: { id: sessionId, status: "PAID_PAGES_READY" },
      data: { status: "CONFIRMED" },
    });

    if (sessionFlip.count === 0) {
      // Someone else won the race, or status drifted. Roll back with a
      // meaningful error rather than let a partial commit slip through.
      throw new ConflictError(
        "Session status changed during send-to-print — please refresh and try again"
      );
    }

    // Flip Order — guard on GENERATED
    const orderFlip = await tx.order.updateMany({
      where: { id: orderId, status: "GENERATED" },
      data: { status: "CONFIRMED" },
    });

    if (orderFlip.count === 0) {
      // Session flipped but Order didn't — data inconsistency. Roll back.
      throw new ConflictError(
        "Order status inconsistent — please contact support"
      );
    }
  });

  logger.info(
    { sessionId, orderId, selectionCount: input.selections.length },
    "Send-to-print committed — session + order flipped to CONFIRMED"
  );

  // Sent-to-print email — exactly once. Only this fresh-commit path sends it:
  // the transaction above refuses a second commit, and every later call takes
  // the CONFIRMED retry branch at the top, which does not email. Sent before
  // the PDF enqueue on purpose — the commit is the event, and a failed enqueue
  // the customer retries must not produce a second email.
  notifySentToPrint(sessionId).catch((err) => {
    logger.error(
      { sessionId, orderId, err },
      "notifySentToPrint failed (swallowed)"
    );
  });

  // 6. Enqueue PDF compilation OUTSIDE the transaction. Redis never inside
  // $transaction (Redis doesn't roll back with Prisma).
  //
  // Job ID = sessionId so BullMQ dedupes idempotent retries. If this enqueue
  // fails, the customer can safely re-hit the endpoint — the idempotent
  // branch at the top will re-enqueue.
  await pdfCompilationQueue.add(
    "compile-pdf",
    { orderSessionId: sessionId },
    { jobId: sessionId }
  );

  logger.info(
    { sessionId, orderId },
    "PDF compilation job enqueued after send-to-print"
  );

  return {
    sessionId,
    orderId,
    status: "CONFIRMED" as const,
    pdfCompilationEnqueued: true,
  };
}



// ============================================================================
// PDF COMPILATION
// ============================================================================

/**
 * Build the print-ready PDF for a session and hand off to Shiprocket.
 *
 * Called by the PDF worker after send-to-print enqueues a job.
 *
 * Flow:
 *   1. Fetch session + comic + all selected PageVersions.
 *   2. Flip session CONFIRMED -> COMPILING_PDF (status-guarded).
 *      Idempotent: if already COMPILING_PDF or later, jump straight to
 *      re-enqueueing Shiprocket (BullMQ retry after a crash).
 *   3. Download every selected image from R2, convert PNG->JPEG at 85% quality
 *      using sharp, embed into a new PDF page sized to the image dimensions.
 *   4. Save PDF bytes, upload to R2 public bucket at pdfs/{sessionId}.pdf.
 *   5. Update Order (pdfUrl, pdfDownloadUrl) + flip session to SHIPMENT_QUEUED
 *      in one transaction.
 *   6. Enqueue Shiprocket OUTSIDE the transaction.
 *
 * On thrown error, the caller (worker) catches, logs, and flips session to
 * PDF_FAILED after retries are exhausted.
 */
export async function compilePdfForSession(
  orderSessionId: string
): Promise<{ pdfUrl: string; pdfDownloadUrl: string }> {
  // 1. Fetch everything we need
  const session = await prisma.orderSession.findUnique({
    where: { id: orderSessionId },
    include: {
      order: true,
      comic: { select: { id: true, pageCount: true, title: true } },
    },
  });

  if (!session) {
    throw new NotFoundError(`Session ${orderSessionId} not found`);
  }

  if (!session.order) {
    throw new ConflictError(
      `Session ${orderSessionId} has no Order — cannot compile PDF`
    );
  }

  // Idempotent retry path — worker crashed mid-run and BullMQ re-fired.
  // If session is already past COMPILING_PDF, someone finished it. Return
  // the existing URLs so the worker can still enqueue Shiprocket.
  if (
    session.status === "SHIPMENT_QUEUED" ||
    session.status === "COMPLETED" ||
    session.status === "SHIPMENT_FAILED"
  ) {
    logger.info(
      { orderSessionId, status: session.status },
      "compilePdfForSession called on already-compiled session — returning existing URLs"
    );
    return {
      pdfUrl: session.order.pdfUrl ?? "",
      pdfDownloadUrl: session.order.pdfDownloadUrl ?? "",
    };
  }

  // 2. Flip to COMPILING_PDF. Guard on CONFIRMED (fresh run) OR
  // COMPILING_PDF (retry mid-compile) so both paths are safe.
  const flipResult = await prisma.orderSession.updateMany({
    where: {
      id: orderSessionId,
      status: { in: ["CONFIRMED", "COMPILING_PDF"] },
    },
    data: { status: "COMPILING_PDF" },
  });

  if (flipResult.count === 0) {
    throw new ConflictError(
      `Session ${orderSessionId} is not at CONFIRMED or COMPILING_PDF (current status prevents compilation)`
    );
  }

  logger.info(
    { orderSessionId },
    "PDF compilation started — session flipped to COMPILING_PDF"
  );

  // 3. Fetch selected page variants, ordered by pageNumber.
  // We need pageNumber for ordering and finalImageUrl to download.
  const selectedVersions = await prisma.pageVersion.findMany({
    where: { orderSessionId, isSelected: true },
    select: {
      id: true,
      finalImageUrl: true,
      page: { select: { pageNumber: true } },
    },
    orderBy: { page: { pageNumber: "asc" } },
  });

  if (selectedVersions.length !== session.comic.pageCount) {
    throw new ConflictError(
      `Expected ${session.comic.pageCount} selected variants for PDF, found ${selectedVersions.length}`
    );
  }

  // 4. Build the PDF.
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(session.comic.title);

  for (const pv of selectedVersions) {
    if (!pv.finalImageUrl) {
      throw new ConflictError(
        `Page ${pv.page.pageNumber} has no finalImageUrl — cannot include in PDF`
      );
    }

    // R2 stores finalImageUrl as a full public URL — convert back to a key
    // so downloadFileToBuffer knows where to fetch from.
    const imageKey = getKeyFromPublicUrl(pv.finalImageUrl);
    const pngBuffer = await downloadFileToBuffer("public", imageKey);

    // Convert PNG -> JPEG at 85% quality using sharp.
    // JPEG doesn't support transparency, so composite over white first
    // in case any generated image has alpha (belt-and-suspenders).
    const jpegBuffer = await sharp(pngBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Get pixel dimensions from the JPEG we just produced. These become
    // the PDF page dimensions (1 pixel = 1 PDF point at 72 DPI, but pdf-lib
    // treats source pixel dimensions as the natural page size — printer's
    // DPI handling is downstream).
    const { width, height } = await sharp(jpegBuffer).metadata();
    if (!width || !height) {
      throw new ConflictError(
        `Could not read dimensions for page ${pv.page.pageNumber}`
      );
    }

    const embeddedImage = await pdfDoc.embedJpg(jpegBuffer);
    const pdfPage = pdfDoc.addPage([width, height]);
    pdfPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width,
      height,
    });

    logger.debug(
      { orderSessionId, pageNumber: pv.page.pageNumber, width, height },
      "PDF page added"
    );
  }

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  logger.info(
    { orderSessionId, pageCount: selectedVersions.length, byteSize: pdfBuffer.length },
    "PDF built in memory"
  );

  // 5. Upload to R2 public bucket. Key uses sessionId (UUID) so it's
  // unguessable — same security model as unlisted YouTube URLs.
  const pdfKey = `pdfs/${orderSessionId}.pdf`;
  await uploadFile("public", pdfKey, pdfBuffer, "application/pdf");
  const pdfPublicUrl = getPublicUrl(pdfKey);

  logger.info(
    { orderSessionId, pdfKey, pdfPublicUrl },
    "PDF uploaded to R2 public bucket"
  );

  // 6. Persist URLs on Order + flip session to SHIPMENT_QUEUED in one txn.
  // pdfDownloadExpiry stays null — public bucket URLs don't expire.
  const orderId = session.order.id;

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        pdfUrl: pdfKey,
        pdfDownloadUrl: pdfPublicUrl,
        pdfDownloadExpiry: null,
      },
    });

    const flipResult = await tx.orderSession.updateMany({
      where: { id: orderSessionId, status: "COMPILING_PDF" },
      data: { status: "SHIPMENT_QUEUED" },
    });

    if (flipResult.count === 0) {
      throw new ConflictError(
        "Session status changed during PDF compilation — rolling back"
      );
    }
  });

  logger.info(
    { orderSessionId, orderId },
    "Order updated with PDF URLs, session flipped to SHIPMENT_QUEUED"
  );

  // 7. Enqueue Shiprocket OUTSIDE the transaction. Redis never inside
  // $transaction. Job ID = sessionId for BullMQ dedupe on retries.
  await shiprocketQueue.add(
    "create-shipment",
    { orderSessionId },
    { jobId: orderSessionId }
  );

  logger.info(
    { orderSessionId },
    "Shiprocket job enqueued after PDF compilation"
  );

  return {
    pdfUrl: pdfKey,
    pdfDownloadUrl: pdfPublicUrl,
  };
}