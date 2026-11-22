import { Resend } from "resend";
import { config } from "../config/env.js";
import { logger } from "./logger.js";
import { AppError, ValidationError } from "../utils/errors.js";

// ============================================================
// EMAIL CLIENT (Resend)
// ============================================================
//
// Sole entry point for sending transactional email. Notification service
// (src/services/notification.service.ts - Layer 3) imports from here;
// no other file talks to Resend directly. Same pattern as shiprocket.ts
// and runpodClient.ts.
//
// Sender identity is fixed per environment (config.email.fromAddress +
// fromName). The reply-to address is fixed too (REPLY_TO_ADDRESS below,
// hardcoded by decision). Individual calls only specify recipient, subject,
// and body.
//
// Retry policy:
//   2 attempts total (1 real try + 1 retry) with 500ms backoff.
//   Retries apply to network errors and HTTP 5xx / 429 only.
//   Email is best-effort - callers wrap in try/catch and swallow (Decision D
//   in the notifyUser design). Never let email failure block business logic.

const MAX_SEND_ATTEMPTS = 2;
const SEND_RETRY_DELAY_MS = 500;

// Where customer replies go. Every email is sent FROM noreply@unilakekids.com,
// which has no inbox (the domain has no MX record), so without this a reply
// bounces. The templates in notification.service.ts ask customers NOT to reply
// and to use the support email / WhatsApp instead - but some will reply
// anyway, so this must still point at a mailbox someone reads. Hardcoded by
// decision - change it here.
const REPLY_TO_ADDRESS = "unilake.books@gmail.com";

// Single Resend client instance, reused across all sends. SDK is thread-safe.
const resendClient = new Resend(config.email.resendApiKey);

// A NODE_ENV other than exactly "production" turns the development recipient guard on and every email,
// including the six order emails, is refused unless allow-listed: say which it is, once, at start-up.
logger.info(
  `[Email] NODE_ENV="${config.nodeEnv}": development recipient guard is ${
    config.nodeEnv === "production"
      ? "OFF (every recipient is mailed)"
      : "ACTIVE (only DEV_EMAIL_ALLOWLIST addresses are mailed)"
  }`
);

/** True when sendEmail would accept this recipient: always in production, otherwise only if allow-listed. */
export function isRecipientAllowed(to: string): boolean {
  return (
    config.nodeEnv === "production" ||
    config.devEmailAllowlist.includes(to.trim().toLowerCase())
  );
}

/** The only addresses that can be mailed here, or null when there is no such limit (production). */
export function devAllowedRecipients(): string[] | null {
  return config.nodeEnv === "production" ? null : config.devEmailAllowlist;
}

/**
 * A refusal from Resend, with what Resend said. The message text is exactly what
 * it always was ("... (HTTP 429)"), and this is still an AppError, so existing
 * callers behave as before; bulk senders read providerName and providerStatus to
 * tell a rate limit (nothing was sent) from a bad request (never retry).
 */
export class EmailSendError extends AppError {
  public readonly providerName: string;
  public readonly providerStatus: number;

  constructor(message: string, providerName: string, providerStatus: number) {
    super(message, 502, "EMAIL_SEND_FAILED");
    this.providerName = providerName;
    this.providerStatus = providerStatus;
  }
}

/**
 * Thrown instead of sending when the development guard stops a mail. It is not a
 * Resend failure: nothing was sent and nothing is wrong with the address, so bulk
 * senders must neither mark a row failed nor suppress the address because of it.
 * The message and the log deliberately leave the address out.
 */
export class EmailGuardRefusal extends AppError {
  constructor() {
    super(
      "Email not sent: development guard (recipient is not in DEV_EMAIL_ALLOWLIST)",
      503,
      "EMAIL_GUARD_REFUSED"
    );
  }
}

// ============================================================
// PRIVATE HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decides whether a Resend failure is worth retrying.
 *
 * Retry:  network failures (fetch threw), HTTP 5xx, HTTP 429.
 * Skip:   HTTP 4xx other than 429 - invalid recipient, unverified sender,
 *         malformed payload. These will never succeed on retry.
 *
 * Resend SDK surfaces HTTP status inside the returned error object rather
 * than as a thrown Error; we check both shapes to be safe.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network fetch failure

  if (err instanceof AppError) {
    return /HTTP (5\d{2}|429)/.test(err.message);
  }

  // Resend SDK's own error objects have a numeric `statusCode`
  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
  ) {
    const status = (err as { statusCode: number }).statusCode;
    return status >= 500 || status === 429;
  }

  return false;
}

/**
 * Naive HTML → plain-text fallback. Strips tags, collapses whitespace.
 * Called only when the caller doesn't provide their own `text` version.
 * Not a real HTML-to-text pipeline - just a courtesy so plaintext-only
 * mail clients (screen readers, some corporate filters) see something
 * readable instead of raw markup.
 */
function htmlToPlainText(html: string): string {
  return html
    // <head> holds only the <title>, which would otherwise print as a
    // duplicate first line above the visible header.
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // The hidden preheader line (notification.service.ts withPreheader) is for inboxes, not for the text version.
    .replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/gi, "")
    // Keep link targets: a button is just "See the preview" once its tags are
    // stripped, and the HTML no longer prints the raw URL beside it.
    //
    // A link whose label already IS its address (the footer's
    // "support@unilakekids.com" → mailto:) stays just the label, rather than
    // "support@unilakekids.com: mailto:support@unilakekids.com".
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        const bareHref = href.replace(/^(mailto|tel):/i, "");
        return text === bareHref ? text : `${text}: ${href}`;
      }
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    // Undo the HTML escaping the templates apply (escapeHtml in
    // notification.service.ts), so "Aarav&#39;s" reads "Aarav's". Runs AFTER
    // tag stripping, so a decoded "<" can never form a tag. &amp; goes last so
    // "&amp;lt;" correctly becomes "&lt;", not "<".
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // The HTML is indented source; drop that indentation from every line.
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// PUBLIC API
// ============================================================

export type SendEmailParams = {
  /** Recipient email. Single recipient - multi-send goes through separate calls. */
  to: string;
  /** Subject line. No length enforcement - Gmail truncates at ~70 chars visually. */
  subject: string;
  /** Rich HTML body. Inline styles only - Gmail strips <style> blocks. */
  html: string;
  /**
   * Optional plaintext version. If omitted, we derive one from html.
   * Provide your own for anything customer-facing where formatting matters.
   */
  text?: string;
  /** Extra mail headers, for example List-Unsubscribe. Sent only when given. */
  headers?: Record<string, string>;
  /**
   * Resend's idempotency key: a retry or a second call with the same key cannot
   * produce a second mail (Resend remembers a key for about a day, not verified).
   * Bulk senders pass the id of the row they claimed.
   */
  idempotencyKey?: string;
};

export type SendEmailResult = {
  /** Resend's own message id, useful for tracing in their dashboard. */
  messageId: string;
};

/**
 * Sends one transactional email via Resend.
 *
 * Idempotency: NOT idempotent. Calling twice sends two emails. Callers must
 * dedupe upstream if that matters (webhook handlers already do so via
 * WebhookEvent uniqueness).
 *
 * Errors: throws AppError on permanent failures. Callers should wrap in
 * try/catch and log/swallow - email failure must never block business logic.
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<SendEmailResult> {
  if (!params.to || params.to.trim().length === 0) {
    throw new ValidationError("sendEmail: `to` must be a non-empty string");
  }
  if (!params.subject || params.subject.trim().length === 0) {
    throw new ValidationError("sendEmail: `subject` must be a non-empty string");
  }
  if (!params.html || params.html.trim().length === 0) {
    throw new ValidationError("sendEmail: `html` must be a non-empty string");
  }

  // Outside production a development or test run must never mail a real person: refuse every recipient that
  // is not in DEV_EMAIL_ALLOWLIST (empty list = refuse all). Production ignores the list. "Production" is
  // NODE_ENV=production, which the Dockerfile sets and lib/auth.ts already relies on for its secure cookies,
  // so a wrong value there would break login loudly.
  if (!isRecipientAllowed(params.to)) {
    logger.error(
      "[Email] Refused by the development guard: the recipient is not in DEV_EMAIL_ALLOWLIST"
    );
    throw new EmailGuardRefusal();
  }

  const from = `${config.email.fromName} <${config.email.fromAddress}>`;
  const text = params.text ?? htmlToPlainText(params.html);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      logger.info(
        {
          to: params.to,
          subject: params.subject,
          attempt,
        },
        "[Email] Sending"
      );

      const sendOptions = params.idempotencyKey
        ? { idempotencyKey: params.idempotencyKey }
        : undefined;
      const { data, error } = await resendClient.emails.send(
        {
          from,
          to: params.to,
          replyTo: REPLY_TO_ADDRESS,
          subject: params.subject,
          html: params.html,
          text,
          ...(params.headers ? { headers: params.headers } : {}),
        },
        sendOptions
      );

      // Resend returns errors in the response body, not as thrown exceptions.
      if (error) {
        // Attach a synthetic statusCode so isRetryableError can classify it.
        // Resend's error shape has a `name` (e.g. "invalid_recipient") and
        // `message` - we surface both in our AppError.
        const status =
          "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : 502;
        throw new EmailSendError(
          `Resend send failed: ${error.name ?? "unknown"}: ${error.message ?? ""} (HTTP ${status})`,
          error.name ?? "unknown",
          status
        );
      }

      if (!data?.id) {
        throw new AppError(
          "Resend send returned no message id",
          502,
          "EMAIL_SEND_MALFORMED"
        );
      }

      logger.info(
        { to: params.to, subject: params.subject, messageId: data.id },
        "[Email] Sent"
      );

      return { messageId: data.id };
    } catch (err) {
      lastError = err;

      // Permanent failure - surface immediately.
      if (!isRetryableError(err)) {
        logger.error(
          { to: params.to, subject: params.subject, err },
          "[Email] Permanent failure, not retrying"
        );
        throw err;
      }

      // Out of attempts.
      if (attempt === MAX_SEND_ATTEMPTS) {
        logger.error(
          { to: params.to, subject: params.subject, attempt, err },
          "[Email] Retries exhausted"
        );
        throw err;
      }

      // Retryable and have attempts left.
      logger.warn(
        { to: params.to, subject: params.subject, attempt, err },
        "[Email] Transient failure, retrying"
      );
      await sleep(SEND_RETRY_DELAY_MS);
    }
  }

  // Unreachable.
  throw lastError;
}