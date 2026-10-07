import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendEmail } from "../lib/email.js";
import { config } from "../config/env.js";

// ============================================================
// NOTIFICATION SERVICE — Layer 3
// ============================================================
//
// Six transactional emails to the customer, one per milestone:
//
//   1. notifyPreviewReady      — free preview pages finished      → preview link
//   2. notifyPaymentReceived   — Razorpay payment captured        → preview link
//   3. notifyBookReady         — every paid page finished         → preview link
//   4. notifySentToPrint       — customer committed send-to-print (no button)
//   5. notifyAwbGenerated      — admin packed it, AWB assigned    → tracking link
//   6. notifyOrderDelivered    — Shiprocket reported delivery     (no button)
//
// Wording and layout follow the client's copy for each email (typos fixed).
//
// Not endpoints. Called fire-and-forget from workers, webhook handlers and
// admin flows. Every function follows the same shape:
//   1. Load the minimum data needed for the email
//   2. Build subject + HTML via a template function
//   3. Send via sendEmail (which handles retries)
//   4. Return { sent: true, messageId } or { sent: false, reason } — never throws
//
// Callers still attach a .catch() and swallow: email failure MUST NOT block
// business logic. See Decision D of the notifyUser design.
//
// Exactly-once is the CALLER's job — sendEmail is not idempotent. Each call
// site sits behind a status-guarded flip or webhook dedupe that only one
// invocation can win; see the comment at each call site.
//
// Recipient: OrderSession.notificationEmail, falling back to the Order's
// checkout-time snapshot. The session copy is deliberately left editable after
// payment ("never printed"), so it is the customer's latest choice.

// ============================================================
// SHARED HELPERS
// ============================================================

/**
 * Escapes text for safe interpolation into HTML (element content AND quoted
 * attribute values). Child names come straight from the personalize form, so
 * an unescaped `<` there would let a customer inject markup into an email we
 * send under our own domain.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subjects are plain text, but a newline in a header is never wanted. */
function cleanSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

// ── Child-name wording ──────────────────────────────────────────────────────
//
// Every email names the child. When the session has no name these fall back
// to "your child", capitalised only at the start of a sentence, so the copy
// reads naturally either way. All return UNESCAPED text — escape at the point
// of use in HTML; subjects are plain text and are used as-is.

function nameOf(childName: string | null): string | null {
  return childName?.trim() || null;
}

/** "Aarav" | "your child" — mid-sentence. */
function kid(childName: string | null): string {
  return nameOf(childName) ?? "your child";
}

/** "Aarav's" | "your child's" — mid-sentence. */
function kids(childName: string | null): string {
  const name = nameOf(childName);
  return name ? `${name}'s` : "your child's";
}

/** "Aarav's" | "Your child's" — start of a sentence. */
function Kids(childName: string | null): string {
  const name = nameOf(childName);
  return name ? `${name}'s` : "Your child's";
}

/** The customer's preview page for a session — where the buttons in 1–3 land. */
function previewUrl(sessionId: string): string {
  return `${config.frontendUrl}/personalize/${encodeURIComponent(sessionId)}/preview`;
}

/**
 * The customer's own page for one order, which shows live tracking. Used by
 * email 5's "Track My Order" button only when Shiprocket gave us no tracking
 * link, so the button never disappears.
 */
function orderPageUrl(orderId: string): string {
  return `${config.frontendUrl}/dashboard/orders/${encodeURIComponent(orderId)}`;
}

// Support contacts shown in every email's footer. The footer tells customers
// not to reply and to use these instead.
const SUPPORT_EMAIL = "support@unilakekids.com";
const SUPPORT_WHATSAPP_DISPLAY = "9277163463";
/** wa.me needs the full international number: +91 (India), no plus sign. */
const SUPPORT_WHATSAPP_LINK = "https://wa.me/919277163463";

/**
 * The client-specified CTA colour: green. This shade is dark enough for the
 * white 16px button text to pass WCAG AA (≈5:1); brighter greens fall short.
 */
const BUTTON_GREEN = "#15803D";

/** The session's current address, else the Order's checkout-time copy. */
function resolveRecipient(
  sessionEmail: string | null | undefined,
  orderEmail?: string | null
): string | null {
  return sessionEmail?.trim() || orderEmail?.trim() || null;
}

/**
 * Wraps a per-email body in a consistent header + footer. Keeps all
 * emails visually consistent — brand tweaks land here in one place.
 *
 * Deliberately minimal — no logo, just clean typography — by decision. The
 * footer carries the client's "automated mail, don't reply" notice and the
 * support contacts. (Replies are still routed to a real inbox — see
 * REPLY_TO_ADDRESS in lib/email.ts — in case someone replies anyway.)
 */
function renderEmailShell(bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Unilake Kids</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 16px 40px;border-bottom:1px solid #eee;">
                <div style="font-size:22px;font-weight:600;color:#1a1a1a;">Unilake Kids</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px;font-size:16px;line-height:1.6;color:#333;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px;border-top:1px solid #eee;font-size:13px;line-height:1.6;color:#888;">
                <div>This is an automated mail. Please do not reply to it. For further queries:</div>
                <div style="margin-top:8px;">Mail at: <a href="mailto:${SUPPORT_EMAIL}" style="color:#555;">${SUPPORT_EMAIL}</a></div>
                <div>WhatsApp: <a href="${SUPPORT_WHATSAPP_LINK}" style="color:#555;">${SUPPORT_WHATSAPP_DISPLAY}</a></div>
                <div style="margin-top:12px;">© Unilake Kids</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

/**
 * The one call-to-action style used by every email. Inline styles only —
 * Gmail strips <style> blocks.
 *
 * The button alone, no raw URL beneath it. Plain-text-only clients still get
 * the address: htmlToPlainText in lib/email.ts renders every link as
 * "label: url" when it builds the text part.
 */
function renderButton(href: string, label: string): string {
  return `
    <p style="margin:24px 0;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;background:${BUTTON_GREEN};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a>
    </p>
  `.trim();
}

/**
 * Common return shape from every notify function. `sent: false` never
 * throws — the caller doesn't need to distinguish "email failed" from
 * "email intentionally skipped." Both are swallowed.
 */
type NotifyResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

/**
 * Wraps sendEmail with the try/catch semantic the notification service
 * needs: never throw upward. Returns a structured result so callers can
 * log it if they want, but never surface it to the customer flow.
 */
async function safeSend(
  to: string,
  subject: string,
  html: string
): Promise<NotifyResult> {
  try {
    const result = await sendEmail({ to, subject: cleanSubject(subject), html });
    return { sent: true, messageId: result.messageId };
  } catch (err) {
    logger.error(
      { to, subject, err },
      "[Notification] Email send failed — swallowing to protect caller"
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Everything the session-keyed emails (1–4) need, in one query. */
async function loadSessionContext(orderSessionId: string) {
  return prisma.orderSession.findUnique({
    where: { id: orderSessionId },
    select: {
      id: true,
      notificationEmail: true,
      childName: true,
      order: { select: { notificationEmail: true } },
    },
  });
}

/** Everything the order-keyed emails (5–6) need, in one query. */
async function loadOrderContext(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      notificationEmail: true,
      trackingUrl: true,
      orderSession: {
        select: {
          id: true,
          notificationEmail: true,
          childName: true,
        },
      },
    },
  });
}

// ============================================================
// EMAIL TEMPLATES (per-notification body builders)
// ============================================================
//
// Every interpolated value is escaped here, at the point of use — the
// callers pass raw strings.

//
// Wording is the client's own copy, with only obvious typos fixed. Each email
// has exactly the content the client specified — no extra lines, no comic
// title — and a green button only where the client asked for one (1, 2, 3, 5).

type BodyArgs = { childName: string | null };

/** "Let's make some magic," over "The Unilake Team" — the sign-off block. */
function renderSignOff(closing: string): string {
  return `<p>${escapeHtml(closing)}<br />The Unilake Team</p>`;
}

/** 1. Preview Created — "The Hook". */
function renderPreviewReadyBody(args: BodyArgs & { link: string }): string {
  const name = nameOf(args.childName);
  const buttonLabel = name ? `View ${name}'s Preview` : "View Your Child's Preview";

  return `
    <p>Hi,</p>
    <p>Magic is brewing at Unilake! Our digital artists have just finished the first few pages of ${escapeHtml(kids(args.childName))} personalized story, and we couldn't wait to show you.</p>
    ${renderButton(args.link, buttonLabel)}
    <p>Take a look at how the cinematic illustrations are coming together. If you love where the story is heading, you can grab the full adventure in a Softcover or Premium Hardcover right from the preview page.</p>
    ${renderSignOff("Let's make some magic,")}
  `.trim();
}

/** 2. Payment Successful — "The Reassurance". */
function renderPaymentReceivedBody(args: BodyArgs & { link: string }): string {
  return `
    <p>Hi,</p>
    <p>We got your payment! Thank you for trusting us to create something special for ${escapeHtml(kid(args.childName))}. Our systems are currently spinning up the rest of the pages and piecing the full story together. You can always check the progress and view the full book once it's ready right from your dashboard.</p>
    ${renderButton(args.link, "Go to My Dashboard")}
    <p>We'll email you the second the full book is ready for your review.</p>
    ${renderSignOff("Cheers,")}
  `.trim();
}

/** 3. Full Book Generated — "The Crucial Action". */
function renderBookReadyBody(args: BodyArgs & { link: string }): string {
  return `
    <p>Hi,</p>
    <p>${escapeHtml(Kids(args.childName))} complete storybook has been generated, and it looks incredible.</p>
    <p>Before we send it for PRINT, we need your final thumbs-up. We want to make sure you are 100% happy with how ${escapeHtml(kid(args.childName))} looks in the story.</p>
    <p><strong>Next step:</strong> Click the link below to read through the digital book. Once you're happy with it, just hit the "Send to Print" button on the page.</p>
    ${renderButton(args.link, "Review the Full Book")}
    <p><strong>Note:</strong> We won't print anything until you click the "Send to Print" button on our website, so make sure you do it.</p>
    ${renderSignOff("Cheers,")}
  `.trim();
}

/** 4. Sent for Print — "The Anticipation Builder". No button, by spec. */
function renderSentToPrintBody(args: BodyArgs): string {
  return `
    <p>Hi,</p>
    <p>You hit print, and we went straight to work!</p>
    <p>${escapeHtml(Kids(args.childName))} book is officially in the printing queue. It takes our team about 2 to 3 days to print, bind, and quality-check the physical book to make sure the colors pop and the cover looks perfect.</p>
    <p>We'll send you one more update with a tracking link the moment it leaves our facility.</p>
    ${renderSignOff("Cheers,")}
  `.trim();
}

/** 5. Shipped — "The Handoff". */
function renderAwbGeneratedBody(args: BodyArgs & { trackingLink: string }): string {
  return `
    <p>Hi,</p>
    <p>Great news — ${escapeHtml(kids(args.childName))} personalized book has left the Unilake facility and is in the hands of our delivery partners!</p>
    <p>You can watch its journey right to your doorstep using the Shiprocket tracking link below:</p>
    ${renderButton(args.trackingLink, "Track My Order")}
    <p>We can't wait for you to see it in person.</p>
    ${renderSignOff("Cheers,")}
  `.trim();
}

/** 6. Delivered — "The Peak Experience". No button, by spec. */
function renderOrderDeliveredBody(args: BodyArgs): string {
  return `
    <p>Hi,</p>
    <p>${escapeHtml(Kids(args.childName))} book has officially been delivered!</p>
    <p>We hope this story brings a massive smile to ${escapeHtml(kids(args.childName))} face. Don't forget to check out the fun activities included inside the book to keep the adventure going.</p>
    <p>A quick tip before you dive in: take a look at the back cover. There is a special QR code waiting for you. Scan it to unlock exclusive cashbacks and discounts for your next Unilake adventure!</p>
    ${renderSignOff("Happy reading,")}
  `.trim();
}

// ============================================================
// PUBLIC API — one function per milestone
// ============================================================

/**
 * 1. Free preview pages finished. Pre-payment, so there is no Order — the
 * session's address is the only one.
 * Caller: generationWorker, on maybeMarkPreviewComplete → "ready".
 */
export async function notifyPreviewReady(
  orderSessionId: string
): Promise<NotifyResult> {
  const session = await loadSessionContext(orderSessionId);
  if (!session) {
    logger.warn({ orderSessionId }, "[Notification] notifyPreviewReady — session not found, skipping");
    return { sent: false, reason: "session_not_found" };
  }

  const to = resolveRecipient(session.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `A sneak peek into ${kids(session.childName)} new adventure!`,
    renderEmailShell(
      renderPreviewReadyBody({
        childName: session.childName,
        link: previewUrl(session.id),
      })
    )
  );
}

/**
 * 2. Razorpay payment captured and paid-page generation queued.
 * Caller: webhook.service handlePaymentCaptured, after the GENERATING_PAID flip.
 */
export async function notifyPaymentReceived(
  orderSessionId: string
): Promise<NotifyResult> {
  const session = await loadSessionContext(orderSessionId);
  if (!session) {
    logger.warn({ orderSessionId }, "[Notification] notifyPaymentReceived — session not found, skipping");
    return { sent: false, reason: "session_not_found" };
  }

  const to = resolveRecipient(session.notificationEmail, session.order?.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `Woohoo! ${Kids(session.childName)} book is officially happening 🚀`,
    renderEmailShell(
      renderPaymentReceivedBody({
        childName: session.childName,
        // "Go to My Dashboard" deliberately lands on the book's preview page —
        // where the paid pages appear as they generate — by decision.
        link: previewUrl(session.id),
      })
    )
  );
}

/**
 * 3. Every paid page finished — the customer now picks variants.
 * Caller: generationWorker, on maybeMarkPaidReady → "ready" (both the success
 * path and the failure-with-earlier-success edge).
 */
export async function notifyBookReady(
  orderSessionId: string
): Promise<NotifyResult> {
  const session = await loadSessionContext(orderSessionId);
  if (!session) {
    logger.warn({ orderSessionId }, "[Notification] notifyBookReady — session not found, skipping");
    return { sent: false, reason: "session_not_found" };
  }

  const to = resolveRecipient(session.notificationEmail, session.order?.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `${Kids(session.childName)} full story is ready to be sent to print. We are waiting for your approval.`,
    renderEmailShell(
      renderBookReadyBody({
        childName: session.childName,
        link: previewUrl(session.id),
      })
    )
  );
}

/**
 * 4. Customer committed their selections with Send to Print.
 * Caller: session.service sendToPrint, fresh-commit path only.
 */
export async function notifySentToPrint(
  orderSessionId: string
): Promise<NotifyResult> {
  const session = await loadSessionContext(orderSessionId);
  if (!session) {
    logger.warn({ orderSessionId }, "[Notification] notifySentToPrint — session not found, skipping");
    return { sent: false, reason: "session_not_found" };
  }

  const to = resolveRecipient(session.notificationEmail, session.order?.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `${Kids(session.childName)} book has been sent for print.`,
    renderEmailShell(
      renderSentToPrintBody({
        childName: session.childName,
      })
    )
  );
}

/**
 * 5. Admin entered final dimensions; AWB assigned and pickup scheduled.
 * Reads Order.trackingUrl, which Phase B writes alongside the AWB.
 * Caller: shiprocket.service pushDimensionsAssignAwbAndSchedulePickup.
 */
export async function notifyAwbGenerated(orderId: string): Promise<NotifyResult> {
  const order = await loadOrderContext(orderId);
  if (!order) {
    logger.warn({ orderId }, "[Notification] notifyAwbGenerated — order not found, skipping");
    return { sent: false, reason: "order_not_found" };
  }

  const to = resolveRecipient(order.orderSession.notificationEmail, order.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `It's on the way! Track ${kids(order.orderSession.childName)} book`,
    renderEmailShell(
      renderAwbGeneratedBody({
        childName: order.orderSession.childName,
        // Shiprocket's tracking page when we have it; otherwise the
        // customer's own order page, which shows tracking — so the button
        // is never missing.
        trackingLink: order.trackingUrl || orderPageUrl(order.id),
      })
    )
  );
}

/**
 * 6. Shiprocket webhook flipped Order.status to DELIVERED.
 * Caller: shiprocket.service processShiprocketStatusUpdate.
 */
export async function notifyOrderDelivered(
  orderId: string
): Promise<NotifyResult> {
  const order = await loadOrderContext(orderId);
  if (!order) {
    logger.warn({ orderId }, "[Notification] notifyOrderDelivered — order not found, skipping");
    return { sent: false, reason: "order_not_found" };
  }

  const to = resolveRecipient(order.orderSession.notificationEmail, order.notificationEmail);
  if (!to) return { sent: false, reason: "no_recipient_email" };

  return safeSend(
    to,
    `Special delivery for ${kid(order.orderSession.childName)}!`,
    renderEmailShell(
      renderOrderDeliveredBody({
        childName: order.orderSession.childName,
      })
    )
  );
}
