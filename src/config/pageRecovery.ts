// Limits for the admin's "restart stuck pages" tool (services/pageRecovery.service.ts).

/** A row that was written to less than this long ago is treated as alive. */
export const ADMIN_STUCK_GRACE_MS = 2 * 60 * 1000;

/**
 * A page whose job is still waiting in our queue is called "stuck" only after this
 * long. With a few RunPod workers and up to 16 of our jobs in flight, a healthy
 * restart of a long book leaves later pages waiting for minutes without a write.
 */
export const ADMIN_QUEUE_WAIT_GRACE_MS = 10 * 60 * 1000;

/**
 * A FAILED page, or one that may still be running at RunPod (a GENERATING_SD row
 * with no live job, or a job in state `failed`), is not restarted again within this
 * long without "Restart anyway": each attempt can spend image-service credit.
 */
export const RESTART_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * An `active` job whose row has not been written to for this long is "being made,
 * unusually long". Same number as STUCK_AFTER_MS in jobs/workers/stuckPageSweeper.ts:
 * keep in step.
 */
export const ACTIVE_LONG_MS = 30 * 60 * 1000;

/** At most one restart request per order in this time (in memory; the service runs as one instance). */
export const ORDER_POST_COOLDOWN_MS = 60 * 1000;

/** How long a Redis call may take before the request gives up (the command itself may still run later). */
export const QUEUE_WAIT_MS = 5 * 1000;

/** `pageNumbers` in a restart request: longest book is about 49 pages. */
export const MAX_PAGES_PER_REQUEST = 100;

/** Long-poll: the GET holds the request up to this long, re-checking every LONG_POLL_STEP_MS. */
export const MAX_WAIT_SECONDS = 25;
export const LONG_POLL_STEP_MS = 5 * 1000;

/** Error text shown to the admin and logged is cut to this length, links removed. */
export const MAX_ERROR_TEXT_LENGTH = 200;
