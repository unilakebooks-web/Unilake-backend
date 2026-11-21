import { describe, it, expect, vi, beforeEach } from "vitest";

// Guards the six order emails: their recipient, subject and exact HTML. The
// snapshot was recorded before any reminder code existed, so a change to these
// emails (or to what they pass to sendEmail) shows up as a failing snapshot.

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sessionFindUnique: vi.fn(),
  orderFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/email.js", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    orderSession: { findUnique: mocks.sessionFindUnique },
    order: { findUnique: mocks.orderFindUnique },
  },
}));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/config/env.js", () => ({
  config: { frontendUrl: "https://shop.example.test" },
}));

import {
  notifyPreviewReady,
  notifyPaymentReceived,
  notifyBookReady,
  notifySentToPrint,
  notifyAwbGenerated,
  notifyOrderDelivered,
  notifyPaidAfterDeletion,
} from "../../src/services/notification.service.js";

// A name with markup and quotes proves the escaping is part of what is guarded.
const NAMED = "Aarav <b>&'\"";

function session(childName: string | null) {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    notificationEmail: "parent@example.test",
    childName,
    order: { notificationEmail: "order-parent@example.test" },
  };
}

function order(childName: string | null, trackingUrl: string | null) {
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    notificationEmail: "order-parent@example.test",
    trackingUrl,
    orderSession: {
      id: "00000000-0000-4000-8000-0000000000aa",
      notificationEmail: "parent@example.test",
      childName,
    },
  };
}

const SESSION_EMAILS = [
  ["preview ready", notifyPreviewReady],
  ["payment received", notifyPaymentReceived],
  ["book ready", notifyBookReady],
  ["sent to print", notifySentToPrint],
] as const;

beforeEach(() => {
  mocks.sendEmail.mockReset().mockResolvedValue({ messageId: "m-1" });
  mocks.sessionFindUnique.mockReset();
  mocks.orderFindUnique.mockReset();
});

describe("the six order emails", () => {
  for (const [label, notify] of SESSION_EMAILS) {
    it(`${label}: named child, then no name`, async () => {
      mocks.sessionFindUnique.mockResolvedValue(session(NAMED));
      expect(await notify("s-1")).toEqual({ sent: true, messageId: "m-1" });
      mocks.sessionFindUnique.mockResolvedValue(session(null));
      await notify("s-1");
      expect(mocks.sendEmail.mock.calls.map((c) => c[0])).toMatchSnapshot();
    });
  }

  it("shipped: with a tracking link, then without one", async () => {
    mocks.orderFindUnique.mockResolvedValue(
      order(NAMED, "https://track.example.test/awb/123")
    );
    await notifyAwbGenerated("o-1");
    mocks.orderFindUnique.mockResolvedValue(order(null, null));
    await notifyAwbGenerated("o-1");
    expect(mocks.sendEmail.mock.calls.map((c) => c[0])).toMatchSnapshot();
  });

  it("delivered: named child, then no name", async () => {
    mocks.orderFindUnique.mockResolvedValue(order(NAMED, null));
    await notifyOrderDelivered("o-1");
    mocks.orderFindUnique.mockResolvedValue(order(null, null));
    await notifyOrderDelivered("o-1");
    expect(mocks.sendEmail.mock.calls.map((c) => c[0])).toMatchSnapshot();
  });

  it("sends only the arguments to, subject and html", async () => {
    mocks.sessionFindUnique.mockResolvedValue(session("Mira"));
    await notifyPreviewReady("s-1");
    const firstCall = mocks.sendEmail.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(Object.keys(firstCall![0]).sort()).toEqual([
      "html",
      "subject",
      "to",
    ]);
  });

  it("never throws when Resend fails, and reports why", async () => {
    mocks.sessionFindUnique.mockResolvedValue(session("Mira"));
    mocks.sendEmail.mockRejectedValue(new Error("boom"));
    expect(await notifyBookReady("s-1")).toEqual({
      sent: false,
      reason: "boom",
    });
  });

  it("skips when there is no recipient or no row", async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      ...session("Mira"),
      notificationEmail: " ",
      order: { notificationEmail: null },
    });
    expect(await notifyPaymentReceived("s-1")).toEqual({
      sent: false,
      reason: "no_recipient_email",
    });
    mocks.sessionFindUnique.mockResolvedValue(null);
    expect(await notifyPaymentReceived("s-1")).toEqual({
      sent: false,
      reason: "session_not_found",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

// Automatic data deletion (feature 6): a customer who paid after the files of their preview were deleted.
describe("the paid-after-deletion email", () => {
  it("names the child with every value escaped, promises contact, and links to no book", async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(NAMED));
    expect(await notifyPaidAfterDeletion("s-1")).toEqual({ sent: true, messageId: "m-1" });
    const mail = mocks.sendEmail.mock.calls[0]![0] as { to?: string; subject: string; html: string };
    expect(Object.keys(mail).sort()).toEqual(["html", "subject", "to"]);
    expect(mail.subject).toBe("We received your payment: we will contact you about your book");
    expect(mail.html).toContain("We received your payment for");
    expect(mail.html).toContain("Aarav &lt;b&gt;&amp;");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("Our team will contact you");
    // "Nothing more is needed": no link to a book or to a preview (the footer's contact details are not links to a book).
    expect(mail.html).not.toMatch(/\/personalize\/|\/preview|\/dashboard\/orders/);
  });

  it("works with no child name, and skips with no recipient or no row", async () => {
    mocks.sessionFindUnique.mockResolvedValue(session(null));
    expect(await notifyPaidAfterDeletion("s-1")).toEqual({ sent: true, messageId: "m-1" });
    expect((mocks.sendEmail.mock.calls[0]![0] as { html: string }).html).toContain("We received your payment for");
    mocks.sendEmail.mockClear();
    mocks.sessionFindUnique.mockResolvedValue({
      ...session("Mira"),
      notificationEmail: " ",
      order: { notificationEmail: null },
    });
    expect(await notifyPaidAfterDeletion("s-1")).toEqual({ sent: false, reason: "no_recipient_email" });
    mocks.sessionFindUnique.mockResolvedValue(null);
    expect(await notifyPaidAfterDeletion("s-1")).toEqual({ sent: false, reason: "session_not_found" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when Resend fails, and reports why", async () => {
    mocks.sessionFindUnique.mockResolvedValue(session("Mira"));
    mocks.sendEmail.mockRejectedValue(new Error("boom"));
    expect(await notifyPaidAfterDeletion("s-1")).toEqual({ sent: false, reason: "boom" });
  });
});
