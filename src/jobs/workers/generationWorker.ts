// src/jobs/workers/generationWorker.ts
//
// Consumes jobs from the "sd-generation" queue and runs the full pipeline
// for one PageVersion: text stamp → (RunPod face swap for face pages)
// → upload → notify. On any error, marks the row FAILED, emits page:error,
// releases the photo cache, then re-throws so BullMQ's retry policy applies.

import { Worker, type Job } from "bullmq";
import { randomUUID } from "crypto";
import { redisClient } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { maybeMarkPaidReady } from "../../services/session.service.js";
import {
  uploadFile,
  getPublicUrl,
  getKeyFromPublicUrl,
  downloadFileToBuffer,
} from "../../lib/r2.js";
import {
  emitPageReady,
  emitPageError,
  emitSessionPreviewReady,
  emitSessionPaidReady
} from "../../websocket/event.js";
import { stampTextOnPage } from "./sd/textStamp.js";
import { buildWorkflow } from "./sd/workflow.js";
import { submitAndAwaitResult } from "./sd/runpodClient.js";
import { acquirePhoto, releasePhoto } from "./sd/photoCache.js";
import { buildDisplayImage } from "../../lib/image.js";
import sharp from "sharp";
import {
  notifyBookReady,
  notifyPreviewReady,
} from "../../services/notification.service.js";

type GeneratePageJobData = {
  pageVersionId: string;
};

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Best-effort cleanup on failure. Failures inside this function are logged,
 * never thrown — we're already inside a catch block; a nested throw would mask
 * the original error.
 *
 * `status: FAILED` is written ONLY on the final attempt. While BullMQ still has
 * retries left the row keeps whatever non-terminal status it held when it threw
 * (TEXT_STAMPING / GENERATING_SD / QUEUED), which is the truth: a retry is
 * pending and the page is still being worked on. Only the error message is
 * recorded in the meantime, so the cause of a mid-retry failure is not lost.
 *
 * This is what makes FAILED trustworthy downstream:
 *   - `GET /sessions/:id` only reports FAILED when the page has genuinely given
 *     up, so a client can render a terminal error without waiting on a socket
 *     event, and it survives a refresh.
 *   - `maybeMarkPreviewComplete` counts FAILED as terminal. Writing it on every
 *     attempt meant a concurrent page finishing mid-retry could see a FAILED
 *     row, conclude every page had settled, and flip the session to
 *     PREVIEW_READY while attempt 2 was still running.
 *
 * Trade-off: if the worker process dies between attempts the row is left
 * non-terminal rather than FAILED. Same shape as the orphaned QUEUED rows that
 * `enqueuePreviewGenerationJobs` already recovers from on re-generate.
 */
async function markPageVersionFailed(
  pageVersionId: string,
  err: unknown,
  isFinal: boolean
): Promise<string> {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const errorMessage = rawMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH);

  try {
    await prisma.pageVersion.update({
      where: { id: pageVersionId },
      data: isFinal ? { status: "FAILED", errorMessage } : { errorMessage },
    });
  } catch (dbErr) {
    logger.error(
      { pageVersionId, isFinal, dbErr },
      "[SD Worker] Failed to record PageVersion failure — leaving in prior status"
    );
  }

  return errorMessage;
}

/**
 * Builds the browser-facing derivative of a finished page and uploads it beside
 * the print master, returning its public URL.
 *
 * 🔴 Best-effort on purpose — never throws.
 *
 * By the time this runs, the print PNG is already uploaded and the expensive
 * work (a GPU round trip that can take minutes) is done. Failing the whole job
 * because a resize failed would throw all of that away and hand the user a
 * FAILED page for a purely cosmetic problem.
 *
 * So on failure we log and return null. The API then returns
 * `displayImageUrl: null`, the frontend falls back to `finalImageUrl`, and the
 * user sees their page — just the heavier version. Degraded, not broken.
 */
async function buildAndUploadDisplayImage(
  sessionId: string,
  pageVersionId: string,
  sourceBuffer: Buffer
): Promise<string | null> {
  try {
    const displayBuffer = await buildDisplayImage(sourceBuffer);
    const displayKey = `sessions/${sessionId}/final/${pageVersionId}.webp`;

    await uploadFile("public", displayKey, displayBuffer, "image/webp");

    logger.info(
      {
        pageVersionId,
        printBytes: sourceBuffer.length,
        displayBytes: displayBuffer.length,
        reduction: `${(sourceBuffer.length / displayBuffer.length).toFixed(1)}x`,
      },
      "[SD Worker] Display image uploaded"
    );

    return getPublicUrl(displayKey);
  } catch (err) {
    logger.warn(
      { err, pageVersionId },
      "[SD Worker] Display image build failed — falling back to the print master"
    );
    return null;
  }
}

/**
 * Called after every terminal PageVersion transition (SD_READY or FAILED).
 * Decides whether the session as a whole is now complete, and if so, flips
 * its status atomically to either PREVIEW_READY (any successes) or FAILED
 * (zero successes — every preview page final-failed).
 *
 * Concurrency (audit 9.2): the flip uses `updateMany` with the current status
 * as part of the WHERE clause. Postgres guarantees only one such update can
 * match — a second worker's updateMany will report count=0 and become a no-op.
 * No transactions, no fake row-locks, no duplicate events.
 *
 * Success-wins semantics: if even one preview page reached SD_READY, the
 * session is PREVIEW_READY. FAILED is only written when every preview page
 * has final-failed with zero successes.
 *
 * Returns which branch fired so the caller can emit the right event.
 */
type PreviewCompleteResult = "not-done" | "ready" | "failed";

async function maybeMarkPreviewComplete(
  orderSessionId: string,
  comicId: string
): Promise<PreviewCompleteResult> {
  // `Page.isPreviewPage` is the only source of truth for which pages are
  // free — same filter enqueuePreviewGenerationJobs uses. Counting against
  // Comic.freePreviewPages instead would desync the moment that counter drifts.
  const totalPreviewPages = await prisma.page.count({
    where: { comicId, isPreviewPage: true },
  });

  // No preview pages flagged means nothing was ever enqueued. Never flip.
  if (totalPreviewPages === 0) return "not-done";

  // Every terminal PageVersion row for this session's preview pages —
  // SD_READY (won) or FAILED (final-failed after all BullMQ attempts).
  //
  // Deliberately NOT `distinct: ["pageId"]`: a page can hold several variants
  // (a failed attempt plus a successful regeneration), and collapsing to one
  // row per page before we inspect them would pick an arbitrary variant —
  // there is no ordering that makes that choice meaningful for both of the
  // questions below. Bounded by preview pages × the variant cap, so this is a
  // handful of rows.
  const terminalRows = await prisma.pageVersion.findMany({
    where: {
      orderSessionId,
      status: { in: ["SD_READY", "FAILED"] },
      page: { isPreviewPage: true },
    },
    select: { pageId: true, status: true },
  });

  // Two separate questions, so two sets:
  //   terminalPageIds  — has this page settled at all?
  //   succeededPageIds — did ANY variant of it succeed?
  // A page with variant 0 FAILED and variant 1 SD_READY belongs in both, which
  // is the point: success-wins is evaluated per page, across its variants.
  const terminalPageIds = new Set<string>();
  const succeededPageIds = new Set<string>();

  for (const row of terminalRows) {
    terminalPageIds.add(row.pageId);
    if (row.status === "SD_READY") succeededPageIds.add(row.pageId);
  }

  // Not every preview page has reached a terminal state yet — nothing to do.
  if (terminalPageIds.size < totalPreviewPages) return "not-done";

  // Success-wins: any single SD_READY page keeps the session recoverable.
  const anySuccess = succeededPageIds.size > 0;
  const targetStatus = anySuccess ? "PREVIEW_READY" : "FAILED";

  // Atomic flip. `updateMany` with status in the where clause is Postgres-
  // native single-statement atomicity — a concurrent worker that arrives one
  // microsecond later will match zero rows and its own updateMany will no-op.
  // This is the real fix for audit 9.2 (the previous $transaction claim was
  // relying on a lock that findUnique does not actually take).
  const { count } = await prisma.orderSession.updateMany({
    where: {
      id: orderSessionId,
      status: "GENERATING_PREVIEW", // guard is IN the query, not a JS check
    },
    data: { status: targetStatus },
  });

  // count=0 means someone else already flipped it. Return "not-done" so the
  // caller does not emit a duplicate event.
  if (count === 0) return "not-done";

  return anySuccess ? "ready" : "failed";
}

async function processJob(job: Job<GeneratePageJobData>): Promise<void> {
  const { pageVersionId } = job.data;

  logger.info(
    { jobId: job.id, pageVersionId, attempt: job.attemptsMade + 1 },
    "[SD Worker] Picked up job"
  );

  // === 1. FETCH THE ROW + EVERYTHING RELATED ===
  const pageVersion = await prisma.pageVersion.findUnique({
    where: { id: pageVersionId },
    include: {
      page: {
        include: {
          bubbles: {
            include: { font: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      },
      orderSession: true,
    },
  });

  // Row deleted between enqueue and pickup. Not retryable — return success
  // so BullMQ drops it cleanly. No page:error emit; the row is gone.
  if (!pageVersion) {
    logger.warn(
      { jobId: job.id, pageVersionId },
      "[SD Worker] PageVersion not found, dropping job"
    );
    return;
  }

  const { page, orderSession } = pageVersion;
  const sessionId = orderSession.id;

  // === 2. IDEMPOTENCY GUARD ===
  //
  // Already succeeded on a prior attempt. Re-emit for late-joining browsers
  // and skip. No error handling needed for this branch — nothing acquired
  // or transitioned.
  if (pageVersion.status === "SD_READY" && pageVersion.finalImageUrl) {
    logger.info(
      { jobId: job.id, pageVersionId },
      "[SD Worker] Already SD_READY, re-emitting and skipping"
    );
    emitPageReady(sessionId, {
      pageNumber: page.pageNumber,
      variantIndex: pageVersion.variantIndex,
      imageUrl: pageVersion.finalImageUrl,
      // May be null on rows written before this field existed, or where the
      // derivative failed. The client falls back to imageUrl.
      displayImageUrl: pageVersion.displayImageUrl,
      pageVersionId: pageVersion.id,
    });
    return;
  }

  // === OUTER TRY/CATCH ===
  //
  // Wraps everything from invariant checks onward. Any thrown error marks
  // the row FAILED, emits page:error, releases photo cache if we acquired
  // it, then re-throws so BullMQ retry policy applies.

  let photoAcquired = false;

  try {
    // === 3. GUARD INVARIANTS ===
    //
    // Guards are split into "always required" vs "only if hasFace".
    // Non-face pages don't need bestPhotoUrl, mask, or pagePrompt because
    // they skip RunPod entirely.
    if (!orderSession.childName) {
      throw new Error(`Session ${sessionId} has no childName`);
    }
    if (!orderSession.pronounKey) {
      throw new Error(`Session ${sessionId} has no pronounKey`);
    }
    if (!page.artworkUrl || !page.artworkWidth || !page.artworkHeight) {
      throw new Error(`Page ${page.id} has no artwork or dimensions`);
    }

    // Face-only requirements — mask + prompt for ComfyUI, photo for the swap.
    if (page.hasFace) {
      if (!orderSession.bestPhotoUrl) {
        throw new Error(`Session ${sessionId} has no bestPhotoUrl`);
      }
      if (!page.maskUrl) {
        throw new Error(`Face page ${page.id} has no mask`);
      }
      if (!page.pagePrompt) {
        throw new Error(`Face page ${page.id} has no pagePrompt`);
      }
    }

    // === 4. TEXT STAMP (reuse or fresh) ===
    //
    // Runs for BOTH face and non-face pages. `stampTextOnPage` gracefully
    // returns the raw artwork when a page has zero bubbles — so a non-face
    // no-bubble page just downloads the artwork and re-uploads it, which
    // gives every session its own copy under sessions/{id}/.
    let textStampedUrl = pageVersion.textStampedUrl;

    if (textStampedUrl) {
      logger.info(
        { pageVersionId, textStampedUrl },
        "[SD Worker] Reusing existing text-stamped image from prior attempt"
      );
    } else {
      await prisma.pageVersion.update({
        where: { id: pageVersionId },
        data: { status: "TEXT_STAMPING" },
      });

      const stampedBuffer = await stampTextOnPage({
        page,
        bubbles: page.bubbles,
        childName: orderSession.childName,
        pronounKey: orderSession.pronounKey,
      });

      const stampedKey = `sessions/${sessionId}/stamped/${pageVersionId}.png`;
      await uploadFile("public", stampedKey, stampedBuffer, "image/png");
      textStampedUrl = getPublicUrl(stampedKey);

      await prisma.pageVersion.update({
        where: { id: pageVersionId },
        data: { status: "TEXT_STAMPED", textStampedUrl },
      });

      logger.info(
        { pageVersionId, textStampedUrl, hasFace: page.hasFace },
        "[SD Worker] Text stamped and uploaded"
      );
    }

    // === 5. FORK ON hasFace ===
    //
    // Face pages go through RunPod; non-face pages are done after the
    // stamp step. For non-face pages, we re-upload the stamped buffer
    // under the /final/ prefix so every session owns a full copy — no
    // shared refs to comic-level artwork that would break if the comic
    // gets deleted.

    let finalImageUrl: string;
    // Null when the derivative could not be built — see buildAndUploadDisplayImage.
    let displayImageUrl: string | null = null;
    let comfyJobId: string | null = null;

    if (!page.hasFace) {
      // Non-face path: the stamped image IS the final image. Copy it
      // into sessions/{sessionId}/final/{pageVersionId}.png so the row
      // owns a full copy. We download from R2 and re-upload rather than
      // server-side CopyObject to keep the code path identical to the
      // face branch below.
      logger.info(
        { pageVersionId, pageNumber: page.pageNumber },
        "[SD Worker] Non-face page — skipping RunPod"
      );

      const stampedBuffer = await downloadFileToBuffer(
        "public",
        getKeyFromPublicUrl(textStampedUrl)
      );

      const finalKey = `sessions/${sessionId}/final/${pageVersionId}.png`;
      await uploadFile("public", finalKey, stampedBuffer, "image/png");
      finalImageUrl = getPublicUrl(finalKey);

      displayImageUrl = await buildAndUploadDisplayImage(
        sessionId,
        pageVersionId,
        stampedBuffer
      );
    } else {
      // === 5a. GATHER INPUTS FOR COMFYUI ===
      const stampedBufferForComfy = await downloadFileToBuffer(
        "public",
        getKeyFromPublicUrl(textStampedUrl)
      );

      const maskBuffer = await downloadFileToBuffer(
        "public",
        getKeyFromPublicUrl(page.maskUrl!) // guarded above
      );

      // Photo cache is acquired here; must be released in finally block below.
      const childPhotoBuffer = await acquirePhoto(
        sessionId,
        orderSession.bestPhotoUrl! // guarded above
      );
      photoAcquired = true;

      // === 5b. BUILD THE PATCHED WORKFLOW ===
      //
      // Filenames use .jpg to match the JPEG transcoding done below. ComfyUI's
      // LoadImage node accepts either format, but keeping the extension honest
      // avoids any decoder confusion.
      const artworkFilename = `artwork_${randomUUID()}.jpg`;
      const maskFilename = `mask_${randomUUID()}.jpg`;
      const photoFilename = `photo_${randomUUID()}.jpg`;
      const seed = Math.floor(Math.random() * 1_000_000_000);

      const workflow = buildWorkflow({
        artworkFilename,
        maskFilename,
        childPhotoFilename: photoFilename,
        seed,
        steps: page.steps,
        cfg: page.cfg,
        pagePrompt: page.pagePrompt!, // guarded above
      });

      // === 5c. MARK GENERATING_SD ===
      await prisma.pageVersion.update({
        where: { id: pageVersionId },
        data: {
          status: "GENERATING_SD",
          seed: BigInt(seed),
        },
      });

      // === 5c.5. TRANSCODE TO JPEG FOR RUNPOD PAYLOAD ===
      //
      // Lossless PNG at print resolution is what we STORE in R2 (that's the
      // user-visible / print-bound image). But RunPod caps API payloads at
      // 10 MiB, and a 2000×1455 PNG can hit 8 MB by itself. JPEG at quality
      // 88 gets us to ~400 KB per image with no perceivable quality drop
      // on photorealistic comic art. The face-swap OUTPUT from RunPod is
      // separate — it comes back at ComfyUI's stitched resolution and gets
      // stored as PNG in R2 in section 5e. So print quality is preserved.
      //
      // WATCH: masks are strict black/white with sharp edges. JPEG can
      // slightly blur those edges. If face-swap boundaries look soft in
      // testing, revert the mask to PNG (see loose ends in CURRENT_STATE).
      const stampedJpegBuffer = await sharp(stampedBufferForComfy)
        .jpeg({ quality: 88 })
        .toBuffer();

      const maskJpegBuffer = await sharp(maskBuffer)
        .jpeg({ quality: 88 })
        .toBuffer();

      const childPhotoJpegBuffer = await sharp(childPhotoBuffer)
        .jpeg({ quality: 88 })
        .toBuffer();

      logger.debug(
        {
          pageVersionId,
          stampedKb: Math.round(stampedJpegBuffer.length / 1024),
          maskKb: Math.round(maskJpegBuffer.length / 1024),
          photoKb: Math.round(childPhotoJpegBuffer.length / 1024),
        },
        "[SD Worker] Transcoded RunPod payload to JPEG"
      );

      // === 5d. CALL RUNPOD ===
      const result = await submitAndAwaitResult({
        workflow,
        images: [
          {
            name: artworkFilename,
            image: stampedJpegBuffer.toString("base64"),
          },
          { name: maskFilename, image: maskJpegBuffer.toString("base64") },
          { name: photoFilename, image: childPhotoJpegBuffer.toString("base64") },
        ],
      });

      logger.info(
        {
          pageVersionId,
          comfyJobId: result.jobId,
          delayMs: result.delayTimeMs,
          execMs: result.executionTimeMs,
        },
        "[SD Worker] RunPod returned result"
      );

      // === 5e. UPLOAD FINAL IMAGE ===
      const finalKey = `sessions/${sessionId}/final/${pageVersionId}.png`;
      await uploadFile("public", finalKey, result.imageBuffer, "image/png");
      finalImageUrl = getPublicUrl(finalKey);
      comfyJobId = result.jobId;

      displayImageUrl = await buildAndUploadDisplayImage(
        sessionId,
        pageVersionId,
        result.imageBuffer
      );
    }

    /// === 6. MARK SD_READY ===
    //
    // comfyJobId is nullable — non-face pages don't have one. Both
    // branches converge here so we only have one status write.
    //
    // errorMessage: null explicitly clears any stale error from a previous
    // failed attempt. Without this, a row that fails once and succeeds on
    // retry keeps the old error message even at SD_READY — misleading in
    // both the DB and the GET /sessions response.
    await prisma.pageVersion.update({
      where: { id: pageVersionId },
      data: {
        status: "SD_READY",
        finalImageUrl,
        displayImageUrl,
        comfyJobId,
        errorMessage: null,
      },
    });

    // === 7. NOTIFY BROWSER ===
    //
    // Both URLs go out. `imageUrl` stays the print master so the event shape
    // remains backward compatible; `displayImageUrl` is what a browser should
    // actually render, and is null when the derivative could not be built.
    emitPageReady(sessionId, {
      pageNumber: page.pageNumber,
      variantIndex: pageVersion.variantIndex,
      imageUrl: finalImageUrl,
      displayImageUrl,
      pageVersionId: pageVersion.id,
    });

    // === 8. CHECK IF THIS WAS THE LAST PREVIEW PAGE ===
    //
    // Race-safe via updateMany with status in the WHERE clause (see the
    // function's comment). Fires for face and non-face pages alike — a page
    // is a page as far as preview completion is concerned.
    //
    // Success path can only ever produce "ready" or "not-done" — reaching
    // this line means at least one page (this one) just went SD_READY, so
    // the anySuccess branch will win if all other pages are terminal too.
    const result = await maybeMarkPreviewComplete(
      sessionId,
      orderSession.comicId
    );

    if (result === "ready") {
      logger.info(
        { sessionId },
        "[SD Worker] All preview pages done — session marked PREVIEW_READY"
      );
      emitSessionPreviewReady(sessionId);
      // Exactly once: "ready" is only returned by the one worker whose
      // status-guarded updateMany won the GENERATING_PREVIEW → PREVIEW_READY flip.
      notifyPreviewReady(sessionId).catch((err) => {
        logger.error(
          { sessionId, err },
          "[SD Worker] notifyPreviewReady failed (swallowed)"
        );
      });
    }

    // === 9. CHECK IF THIS WAS THE LAST PAID PAGE ===
    //
    // Same race-safety story as the preview check. Both helpers fire on every
    // page completion — the one whose filter (isPreviewPage) does not match
    // this page's kind returns "not-done" and does nothing. Cleaner than
    // routing at the worker level.
    //
    // Success path can only ever produce "ready" or "not-done" here.
    const paidResult = await maybeMarkPaidReady(
      sessionId,
      orderSession.comicId
    );

    if (paidResult === "ready") {
      logger.info(
        { sessionId },
        "[SD Worker] All paid pages done — session marked PAID_PAGES_READY, Order marked GENERATED"
      );
      emitSessionPaidReady(sessionId);
      // Exactly once — same status-guarded-flip reasoning as the preview email.
      notifyBookReady(sessionId).catch((err) => {
        logger.error(
          { sessionId, err },
          "[SD Worker] notifyBookReady failed (swallowed)"
        );
      });
    }
    
    logger.info(
      {
        jobId: job.id,
        pageVersionId,
        pageNumber: page.pageNumber,
        hasFace: page.hasFace,
        finalImageUrl,
      },
      "[SD Worker] Job complete"
    );
  } catch (err) {
    // === ERROR PATH ===
    //
    // Mark FAILED with readable message, tell the browser, re-throw so
    // BullMQ can retry per its attempts:3 backoff policy.
    logger.error(
      {
        jobId: job.id,
        pageVersionId,
        attempt: job.attemptsMade + 1,
        err,
      },
      "[SD Worker] Pipeline failed"
    );

    // Inside processJob, `attemptsMade` is the count BEFORE this attempt — 0 on
    // the first run, which is why the log above reads `attemptsMade + 1`. The
    // `failed` handler below compares the un-incremented value instead, because
    // BullMQ has already bumped it by the time that event fires. Both are
    // correct in their own scope; do not unify them.
    const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    const errorMessage = await markPageVersionFailed(pageVersionId, err, isFinal);

    emitPageError(sessionId, {
      pageNumber: page.pageNumber,
      variantIndex: pageVersion.variantIndex,
      errorMessage,
      isFinal,
    });

    throw err;
  } finally {
    // === CLEANUP ===
    //
    // Release photo cache slot ONLY if we successfully acquired it. Runs on
    // both success and failure paths — no leaked refcounts either way.
    // Non-face pages never call acquirePhoto so photoAcquired stays false
    // and this correctly skips the release.
    if (photoAcquired) {
      releasePhoto(sessionId);
    }
  }
}

export const generationWorker = new Worker<GeneratePageJobData>(
  "sd-generation",
  processJob,
  { connection: redisClient, concurrency: 5}
);

generationWorker.on("failed", async (job, err) => {
  logger.error(
    { jobId: job?.id, pageVersionId: job?.data?.pageVersionId, err },
    "[SD Worker] Job failed"
  );

  if (!job) return;

  // BullMQ's `failed` event fires on EVERY failed attempt, not just the last.
  // Only run the completion check on the final attempt — retries in progress
  // must not be treated as terminal failures.
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade >= maxAttempts;

  if (!isFinalAttempt) return;

  // The job data only carries pageVersionId. Look up the session + comic so
  // we can pass them to the completion check. This runs OUTSIDE the worker's
  // processJob transaction, so a Prisma call here is safe.
  const { pageVersionId } = job.data;

  try {
    const pageVersion = await prisma.pageVersion.findUnique({
      where: { id: pageVersionId },
      select: {
        orderSessionId: true,
        orderSession: { select: { comicId: true } },
      },
    });

    if (!pageVersion) {
      logger.warn(
        { pageVersionId },
        "[SD Worker] Terminal-failure handler: PageVersion not found, skipping"
      );
      return;
    }

    const result = await maybeMarkPreviewComplete(
      pageVersion.orderSessionId,
      pageVersion.orderSession.comicId
    );

    if (result === "failed") {
      logger.error(
        { sessionId: pageVersion.orderSessionId },
        "[SD Worker] All preview pages final-failed — session marked FAILED"
      );
      // Intentionally no WebSocket emit here (Decision 4 skipped).
      // Frontend learns via per-page `page:error` events + GET /sessions/:id.
    } else if (result === "ready") {
      // Edge case: this page failed, but earlier successes already covered
      // the total. Rare — would only happen if failure and last success
      // finish in an unusual order. Emit the ready event so a connected
      // client doesn't miss the transition.
      logger.info(
        { sessionId: pageVersion.orderSessionId },
        "[SD Worker] Session marked PREVIEW_READY from failure handler (last page failed but earlier pages covered the total)"
      );
      emitSessionPreviewReady(pageVersion.orderSessionId);
      notifyPreviewReady(pageVersion.orderSessionId).catch((err) => {
        logger.error(
          { sessionId: pageVersion.orderSessionId, err },
          "[SD Worker] notifyPreviewReady failed (swallowed)"
        );
      });
    }
    // Mirror check for paid pages. Same rationale as the preview branch
    // above — the helper whose isPreviewPage filter doesn't match this
    // page will no-op.
    const paidResult = await maybeMarkPaidReady(
      pageVersion.orderSessionId,
      pageVersion.orderSession.comicId
    );

    if (paidResult === "failed") {
      logger.error(
        { sessionId: pageVersion.orderSessionId },
        "[SD Worker] All paid pages final-failed — session marked FAILED, Order left at PAID for admin review"
      );
      // No WebSocket emit — matches preview failure handling. Frontend
      // picks it up via page:error + GET /sessions/:id.
    } else if (paidResult === "ready") {
      // Same edge case as above but for paid: this page failed, earlier
      // successes already covered the total.
      logger.info(
        { sessionId: pageVersion.orderSessionId },
        "[SD Worker] Session marked PAID_PAGES_READY from failure handler (last page failed but earlier pages covered the total)"
      );
      emitSessionPaidReady(pageVersion.orderSessionId);
      notifyBookReady(pageVersion.orderSessionId).catch((err) => {
        logger.error(
          { sessionId: pageVersion.orderSessionId, err },
          "[SD Worker] notifyBookReady failed (swallowed)"
        );
      });
    }
  } catch (handlerErr) {
    // A crash inside the terminal-failure handler must not itself crash the
    // worker. Log it and move on — the session will stay in
    // GENERATING_PREVIEW, which is exactly the pre-fix behaviour, not worse.
    logger.error(
      { pageVersionId, handlerErr },
      "[SD Worker] Terminal-failure handler crashed"
    );
  }
});
