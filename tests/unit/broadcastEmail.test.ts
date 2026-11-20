import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/email.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/config/env.js", () => ({
  config: { frontendUrl: "https://shop.example.test" },
}));

import {
  renderBroadcastEmail,
  type BroadcastEmailArgs,
} from "../../src/services/notification.service.js";
import {
  createBroadcastSchema,
  startBroadcastSchema,
  updateBroadcastSchema,
} from "../../src/validators/broadcast.schema.js";

const args = (over: Partial<BroadcastEmailArgs> = {}): BroadcastEmailArgs => ({
  subject: "Diwali offer",
  heading: "A little something",
  message: "First line.\n\nSecond paragraph\nwith a break.",
  buttonText: "See the books",
  buttonUrl: "https://shop.example.test/books",
  optedIn: true,
  stopUrl: "https://shop.example.test/unsubscribe?t=tok",
  ...over,
});

describe("renderBroadcastEmail", () => {
  it("escapes the admin's text everywhere and keeps paragraphs and line breaks", () => {
    const { html, subject } = renderBroadcastEmail(
      args({
        subject: "A <b>sale</b>\r\nBcc: x",
        heading: `<script>alert(1)</script>`,
        message: `Hello <i>there</i> & "you"\n\nSecond`,
        buttonText: "<go>",
      })
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<i>there");
    expect(html).toContain("&lt;i&gt;there&lt;/i&gt; &amp; &quot;you&quot;");
    expect(html).toContain("&lt;go&gt;");
    expect(renderBroadcastEmail(args()).html).toContain(
      "Second paragraph<br />with a break."
    );
  });

  it("has a button only when both the text and the link are given", () => {
    expect(renderBroadcastEmail(args()).html).toContain(
      'href="https://shop.example.test/books"'
    );
    for (const over of [{ buttonText: null }, { buttonUrl: null }]) {
      expect(renderBroadcastEmail(args(over)).html).not.toContain(
        "background:#15803D"
      );
    }
  });

  it("the footer says why the person gets it, by audience, and links to the stop page", () => {
    const optedIn = renderBroadcastEmail(args({ optedIn: true })).html;
    const customer = renderBroadcastEmail(args({ optedIn: false })).html;
    expect(optedIn).toContain("because you chose to hear from Unilake");
    expect(customer).toContain("because you ordered from Unilake");
    for (const html of [optedIn, customer]) {
      expect(html).toContain(
        'href="https://shop.example.test/unsubscribe?t=tok"'
      );
      expect(html).toContain("Unsubscribe");
    }
  });

  it("a dollar sign in the message is text, not a replacement pattern (the preheader and the body stay intact)", () => {
    const { html } = renderBroadcastEmail(
      args({ message: "Flat $1 off, save $& more, $$ too" })
    );
    expect(html.match(/<body/gi)).toHaveLength(1);
    expect(html).toContain(">Flat $1 off, save $&amp; more, $$ too</div>");
  });

  it("a long first line is cut by characters: an emoji at the cut is never split", () => {
    const { html } = renderBroadcastEmail(
      args({ message: "a".repeat(108) + "🎉" + "b".repeat(20) })
    );
    expect(html).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
    expect(html).toContain("…");
  });

  it("emoji and Devanagari in the subject, heading and message are kept whole", () => {
    const { subject, html } = renderBroadcastEmail(
      args({
        subject: "दिवाली 🎉 offer",
        heading: "नमस्ते 😀",
        message: "कहानी की किताब 📖",
      })
    );
    expect(subject).toBe("दिवाली 🎉 offer");
    expect(html).toContain("नमस्ते 😀");
    expect(html).toContain("कहानी की किताब 📖");
  });

  it("puts the first line of the message in a hidden preheader before the visible header", () => {
    const { html } = renderBroadcastEmail(args());
    expect(html.indexOf("display:none")).toBeGreaterThan(-1);
    expect(html.indexOf("display:none")).toBeLessThan(
      html.indexOf("Unilake Kids</div>")
    );
    expect(html).toContain(">First line.</div>");
  });
});

describe("broadcast validators", () => {
  const good = {
    subject: "Hi",
    heading: "Hello",
    message: "Body",
    buttonText: "Go",
    buttonUrl: "https://example.com/x",
  };
  const ok = (body: unknown) => createBroadcastSchema.safeParse(body).success;

  it("accepts a complete broadcast with or without a button", () => {
    expect(ok(good)).toBe(true);
    expect(ok({ subject: "Hi", heading: "Hello", message: "Body" })).toBe(true);
  });

  it("refuses a button link that is not plain https, or carries credentials", () => {
    for (const buttonUrl of [
      "http://example.com",
      "javascript:alert(1)",
      "https://user:pw@example.com",
      "ftp://example.com",
      "not a url",
    ]) {
      expect(ok({ ...good, buttonUrl })).toBe(false);
    }
  });

  it("needs both halves of the button or neither", () => {
    expect(ok({ ...good, buttonText: null })).toBe(false);
    expect(ok({ ...good, buttonUrl: null })).toBe(false);
  });

  it("refuses an empty or multi-line subject and heading, and a message that is too long", () => {
    expect(ok({ ...good, subject: "  " })).toBe(false);
    expect(ok({ ...good, subject: "a\nb" })).toBe(false);
    expect(ok({ ...good, heading: "a\r\nb" })).toBe(false);
    expect(ok({ ...good, message: "x".repeat(5001) })).toBe(false);
  });

  it("refuses an unknown audience, and an empty update", () => {
    expect(ok({ ...good, audience: "EVERYONE" })).toBe(false);
    expect(updateBroadcastSchema.safeParse({}).success).toBe(false);
    expect(updateBroadcastSchema.safeParse({ subject: "New" }).success).toBe(
      true
    );
  });

  it("refuses more link and length edge cases: a username alone, no scheme, a 2001-character link, a 151-character subject", () => {
    expect(ok({ ...good, buttonUrl: "https://user@evil.example.com" })).toBe(
      false
    );
    expect(ok({ ...good, buttonUrl: "example.com/path" })).toBe(false);
    expect(
      ok({ ...good, buttonUrl: "https://example.com/" + "x".repeat(1980) })
    ).toBe(true);
    expect(
      ok({ ...good, buttonUrl: "https://example.com/" + "x".repeat(1981) })
    ).toBe(false);
    expect(ok({ ...good, subject: "s".repeat(150) })).toBe(true);
    expect(ok({ ...good, subject: "s".repeat(151) })).toBe(false);
  });

  it("send needs the count the admin saw", () => {
    expect(startBroadcastSchema.safeParse({}).success).toBe(false);
    expect(
      startBroadcastSchema.safeParse({ confirmRecipientCount: 0 }).success
    ).toBe(false);
    expect(
      startBroadcastSchema.safeParse({ confirmRecipientCount: 12 }).success
    ).toBe(true);
  });
});
