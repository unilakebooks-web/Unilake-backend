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

// Alphabet for generated (single-use) codes. Leaves out 0, O, 1 and I so a code
// read out loud or copied from a screenshot cannot be mistaken for another.
export const GENERATED_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const GENERATED_CODE_LENGTH = 8;

// Most single-use codes one bulk request may create.
export const MAX_BULK_GENERATE = 100;

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

// ============================================================
// PAYMENT MINIMUM
// ============================================================
//
// A discount never leaves less than this to pay, in major units of the order's
// currency. Razorpay refuses very small orders: in test mode INR needs at least
// 1.00 (100 paise) and 1.00 was accepted for INR, USD, EUR, GBP, AED and SGD.
// Zero-decimal and three-decimal currencies are not verified; 1 major unit is a
// deliberately safe floor for them too.
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
  NOT_APPLICABLE: "This code does not apply to this book.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Please try again in a few minutes.",
  CHANGED_RETRY: "This offer was just updated. Please try again.",
} as const;

export type CouponMessageKey = keyof typeof COUPON_MESSAGES;
