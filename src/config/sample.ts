// ⚠️ The admin screen repeats MAX_SAMPLE_PAGES, SAMPLE_TTL_HOURS and the cleanup delay (margin plus
// the sweep interval): frontend components/admin/sample/sampleConfig.ts. Two repos, change both.
//
// Admin sample books. A sample is a real OrderSession flagged isSample: it is made by
// an admin to try a book, never gets an Order, and its files and rows are deleted after it expires.

/** How long a sample lives, counted from creation. Discarding a sample ends it at once. */
export const SAMPLE_TTL_HOURS = 6;
export const SAMPLE_TTL_MS = SAMPLE_TTL_HOURS * 60 * 60 * 1000;

/**
 * A sample is only cleaned up this long after it expired. Longer than the 5-minute presigned photo
 * upload (PHOTO_UPLOAD_EXPIRY_SECONDS in session.service.ts), so a late browser upload cannot land
 * after the cleanup. With the 5-minute Cloud Scheduler job, files are gone about 15 minutes after expiry.
 */
export const SAMPLE_CLEANUP_MARGIN_MS = 10 * 60 * 1000;

/** Pages in one sample: the admin chooses them, and each one costs a RunPod run. */
export const MAX_SAMPLE_PAGES = 12;

/** Samples that have not expired yet, per admin and overall. */
export const MAX_LIVE_SAMPLES_PER_ADMIN = 3;
export const MAX_LIVE_SAMPLES_OVERALL = 5;

/**
 * Largest sample PDF the server will send. Measured 2026-11-19: 12 print-size pages (2480x3508) of
 * photographic noise, the worst case, gave a 20.8 MB PDF; real pages give about 3 MB. Cloud Run's
 * response limit is believed to be 32 MiB (not verified), so the cap stays below it.
 */
export const MAX_SAMPLE_PDF_BYTES = 25 * 1024 * 1024;

/** No new sample while this many sample pages are still queued or generating. */
export const MAX_SAMPLE_PAGES_IN_FLIGHT = 24;

/**
 * One sweep run stops starting new samples after this long, so it ends inside the 120 s timeout of
 * the scheduled-sweeps runner (SWEEP_TIMEOUT_MS in scheduledSweeps.service.ts). The rest waits for the next run.
 */
export const SAMPLE_SWEEP_BUDGET_MS = 90_000;

/**
 * A sweep that has been "running" longer than this is treated as hung (a storage call that never
 * answers), so the next run may start. Above the 120 s runner timeout and the 90 s budget.
 */
export const SAMPLE_SWEEP_STALE_MS = 150_000;

/** The create transaction makes several round trips to the database, so it gets more than Prisma's 5 s default. */
export const SAMPLE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** Sessions removed per sweep run, so one run stays well inside the 120 s sweep timeout. */
export const SAMPLE_SWEEP_BATCH = 20;

/**
 * The refusal every customer route gives for a sample id.
 *
 * ⚠️ Used by session.service.ts (updateOrderSession, attachUserToSession, sendToPrint) and
 * checkout.service.ts (initiateCheckout). A sample must never reach payment.
 */
export const SAMPLE_REFUSAL_MESSAGE =
  "This is an admin sample book. It cannot be edited, claimed, paid for or printed.";
