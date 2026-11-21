// Settings of the view-only share link (feature 14). See docs/phase2/features/09-sharing/PLAN.md.

/** A share token is 24 random bytes in base64url: exactly 32 characters. Anything else cannot be one of ours. */
export const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;

/** The largest image the share routes will read from storage. A web page image is about 250 KB. */
export const SHARE_MAX_OBJECT_BYTES = 2 * 1024 * 1024;

/** Bytes of image data held in memory by all share requests at once; a request over this waits, then gets a 503. */
export const SHARE_BYTE_BUDGET = 24 * 1024 * 1024;

/** How long a request waits for room in the byte budget before the 503. */
export const SHARE_WAIT_MS = 3000;

/** Storage: time allowed to connect and receive the first byte, and then to read the body. */
export const SHARE_FIRST_BYTE_TIMEOUT_MS = 10_000;
export const SHARE_READ_DEADLINE_MS = 15_000;

/** A client that does not take the response within this time is disconnected, so it cannot hold memory. */
export const SHARE_WRITE_DEADLINE_MS = 10_000;

/** `Retry-After` seconds on a 503. */
export const SHARE_RETRY_AFTER_SECONDS = 2;

/** Browsers and crawlers may keep a share image this long; a revoked share's images can stay visible this long. */
export const SHARE_IMAGE_MAX_AGE_SECONDS = 60;

/** The link-preview card: a JPEG this wide, kept under this size. */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_MAX_BYTES = 300 * 1024;
export const SHARE_CARD_QUALITIES = [80, 70, 60];
export const SHARE_CARD_CONCURRENCY = 2;
export const SHARE_CARD_CACHE_ENTRIES = 20;
