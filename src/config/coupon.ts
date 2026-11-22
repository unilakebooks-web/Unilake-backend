// Tunables and customer-facing wording for coupon codes.
//
// Everything below is a business call rather than an implementation detail, so
// it lives here (like stats.ts and shipping.ts) instead of inside the services.

// ============================================================
// CODE FORMAT
// ============================================================
//
// Stored upper-case. The same pattern is enforced by a CHECK constraint on
// coupons.code, so changing it here means changing the database as well.
export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;

// The length bounds in COUPON_CODE_PATTERN, for messages and range checks.
export const COUPON_CODE_MIN = 4;
export const COUPON_CODE_MAX = 32;

// Alphabet for generated (single-use) codes. Leaves out 0, O, 1 and I so a code
// read out loud or copied from a screenshot cannot be mistaken for another.
export const GENERATED_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const GENERATED_CODE_LENGTH = 8;

// Most single-use codes the admin can create in one go. Each batch is one
// transaction of three statements however many codes it holds; the cap keeps
// the response, the list and the admin's copy and paste manageable.
// ⚠️ also in unilake-frontend/components/admin/coupon/couponFormRules.ts (MAX_BULK_COUPONS)
export const MAX_BULK_COUPONS = 100;

// ============================================================
// RESERVATIONS
// ============================================================
//
// An unpaid order holds ("reserves") a use of its coupon. A reservation stops
// counting against the limits once it is older than this, with no background
// job: the same query that enforces the limits simply ignores stale ones.
//
// A Razorpay order stays payable long after this (a test order was still
// payable after 58 minutes), so a customer can still pay a lapsed reservation.
// That payment is always honoured and counts as redeemed; the limit can
// therefore be exceeded by the few who pay late.
export const RESERVATION_WINDOW_MINUTES = 60;

// Options for the one transaction that reserves a coupon use. Waiting on the
// coupon's row lock can take a few seconds when many customers use the same
// coupon at once (about 0.35 s each from India to Neon), and Prisma's defaults
// (2 s to start, 5 s to finish) failed 4 of 20 in a burst. Only this
// transaction gets the longer limits.
export const COUPON_TRANSACTION_OPTIONS = {
  maxWait: 15000,
  timeout: 30000,
} as const;

// ============================================================
// PAYMENT MINIMUM
// ============================================================
//
// A discount never leaves less than this to pay, in major units of the order's
// currency. Razorpay refuses very small orders: in test mode INR needs at least
// 1.00 (100 paise) and 1.00 was accepted for INR, USD, EUR, GBP, AED and SGD.
// Zero-decimal and three-decimal currencies are not verified; 1 major unit is a
// deliberately safe floor for them too.
// ⚠️ also in unilake-frontend/components/checkout/couponOffers.ts (PAYMENT_MINIMUM)
export const MIN_PAYABLE_MAJOR_UNITS = 1;

// ============================================================
// BRUTE-FORCE PROTECTION
// ============================================================
//
// Failed code attempts allowed per customer in the window before they are told
// to wait. Counted in Redis; if Redis is down the limiter lets the attempt
// through (the usage limits themselves never fail open).
export const MAX_FAILED_COUPON_ATTEMPTS = 10;
export const FAILED_COUPON_ATTEMPT_WINDOW_SECONDS = 10 * 60;
// The same window also counts failed attempts per IP address, so one machine cannot get a fresh
// allowance by switching accounts. Higher than the per-account limit, so a shared address (an
// office, a mobile network) is not locked out by a few customers' typos.
export const MAX_FAILED_COUPON_ATTEMPTS_PER_IP = 30;

// With Redis down the client queues commands until it reconnects (the job queue
// needs that), so a plain await would hang the customer's request. The attempt
// limiter gives up after this long and treats Redis as unavailable.
export const REDIS_WAIT_MS = 500;

// ============================================================
// CUSTOMER-FACING MESSAGES
// ============================================================
//
// Shown as-is by the frontend. A code that is inactive, unknown, or reserved
// for a different customer all get the same INVALID message, so a private code
// cannot be discovered by trying it.
export const COUPON_MESSAGES = {
  INVALID: "This code is not valid.",
  NOT_STARTED: "This code is not active yet.",
  EXPIRED: "This code has expired.",
  USED_UP: "This code has been used up.",
  ALREADY_USED: "You have already used this code.",
  WRONG_CURRENCY: "This code is not valid for orders in this currency.",
  NOT_APPLICABLE: "This code does not apply to this book.",
  FIRST_ORDER_ONLY: "This code is only for a customer's first order.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Please try again in about 10 minutes.",
  CHANGED_RETRY: "This offer was just updated. Please try again.",
} as const;

// Longest code text the API accepts from a customer. Longer than a real code (4 to 32
// characters) so pasted spaces or typos still reach the "not valid" answer; the
// checkout page's input uses the same limit.
export const COUPON_CODE_INPUT_MAX = 64;

// A customer's coupon uses are also matched by the delivery phone number, so a second
// account cannot reuse a per-customer or first-order-only code. The phone is compared by
// its last digits (country code and leading zero ignored); a shorter number is not compared.
export const PHONE_KEY_DIGITS = 10;
