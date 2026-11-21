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
  renderReminderEmail,
  type ReminderEmailArgs,
  type ReminderEmailKind,
} from "../../src/services/notification.service.js";

const NAME = "Aarav";
const base = (over: Partial<ReminderEmailArgs> = {}): ReminderEmailArgs => ({
  kind: "PREVIEW_UNFINISHED",
  step: 0,
  total: 3,
  childName: NAME,
  bookTitle: "Pirate Island",
  coverUrl: "https://img.example.test/cover.webp",
  link: "https://shop.example.test/personalize/abc/preview",
  deletionDate: null,
  couponCode: null,
  stopUrl: "https://shop.example.test/unsubscribe?t=tok",
  ...over,
});

const KINDS: ReminderEmailKind[] = [
  "PREVIEW_UNFINISHED",
  "BOOK_NOT_SENT",
  "REVIEW_REQUEST",
];

describe("every reminder", () => {
  for (const kind of KINDS) {
    for (const [step, total] of [
      [0, 1],
      [0, 3],
      [1, 3],
      [2, 3],
      [1, 2],
    ] as const) {
      it(`${kind} step ${step} of ${total}: the subject never holds the child's name, and no newline`, () => {
        const { subject } = renderReminderEmail(base({ kind, step, total }));
        expect(subject).not.toContain(NAME);
        expect(subject).not.toMatch(/[\r\n]/);
        expect(subject.length).toBeGreaterThan(5);
      });
    }

    it(`${kind}: a name with markup is escaped in the body and the book title is escaped too`, () => {
      const { html } = renderReminderEmail(
        base({
          kind,
          childName: `<b>"Aa'</b>`,
          bookTitle: `Tom & <i>Jerry</i>`,
        })
      );
      expect(html).not.toContain("<b>");
      expect(html).not.toContain("<i>Jerry");
      expect(html).toContain("&lt;b&gt;");
      // The book title is in the body of A (alt text) and C; B's body names only the child.
      if (kind !== "BOOK_NOT_SENT")
        expect(html).toContain("Tom &amp; &lt;i&gt;Jerry&lt;/i&gt;");
    });

    it(`${kind}: with no child's name the copy falls back to "your child"`, () => {
      const { html } = renderReminderEmail(base({ kind, childName: null }));
      expect(html.toLowerCase()).toContain("your child");
    });

    it(`${kind}: one button to the given link, a hidden preheader before the visible header, and a stop link`, () => {
      const args = base({ kind });
      const { html } = renderReminderEmail(args);
      expect(html).toContain(`href="${args.link}"`);
      expect(html).toContain(`href="${args.stopUrl}"`);
      expect(html.indexOf("display:none")).toBeGreaterThan(-1);
      expect(html.indexOf("display:none")).toBeLessThan(
        html.indexOf("Unilake Kids</div>")
      );
      // exactly one green call-to-action button
      expect(html.match(/background:#15803D/g)).toHaveLength(1);
    });
  }

  it("a long title is cut by characters: an emoji or a Devanagari letter is never split", () => {
    for (const unit of ["😀", "कि", "é"]) {
      const { subject } = renderReminderEmail(
        base({ bookTitle: unit.repeat(80) })
      );
      // no lone surrogate, and the cut ends on a whole character plus the ellipsis
      expect(subject).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
      expect(subject).toContain("…");
      // the title was cut to its limit in whole characters
      expect(
        Array.from(subject.split("…")[0]!.replace("Your ", "")).every(
          (c) => c === unit || c === " " || unit.includes(c)
        )
      ).toBe(true);
    }
  });

  it("a long book title is shortened in the subject only", () => {
    const long = "A Very Long Book Title That Goes On And On Forever And Ever";
    const { subject, html } = renderReminderEmail(base({ bookTitle: long }));
    expect(subject).toContain("…");
    expect(subject.length).toBeLessThan(long.length + 40);
    expect(html).not.toContain("…");
  });
});

describe("A, the unfinished preview", () => {
  it("shows the book's cover with alt text, and uses the first, middle and last wording", () => {
    const first = renderReminderEmail(base({ step: 0 }));
    const middle = renderReminderEmail(base({ step: 1 }));
    const last = renderReminderEmail(base({ step: 2 }));
    expect(first.html).toContain('src="https://img.example.test/cover.webp"');
    expect(first.html).toContain('alt="Pirate Island cover"');
    expect(first.subject).toBe("Your Pirate Island story preview is waiting");
    expect(middle.subject).toBe("Your Pirate Island preview is still saved");
    expect(last.subject).toBe("Your Pirate Island preview: a final reminder");
    expect(first.html).toContain("approve it on that page");
    expect(middle.html).not.toContain("approve it on that page");
  });

  it("a send that is last in the list but the first this customer gets is not called a final reminder, and still carries the date and the coupon", () => {
    const html = (alreadyReminded: boolean) =>
      renderReminderEmail(
        base({
          step: 2,
          deletionDate: "17 November 2026",
          couponCode: "WELCOME-10",
          alreadyReminded,
        })
      );
    const fresh = html(false);
    expect(fresh.subject).not.toContain("final reminder");
    expect(fresh.html).not.toContain("final reminder");
    expect(fresh.html).toContain(
      "will be deleted on <strong>17 November 2026</strong>"
    );
    expect(fresh.html).toContain("<strong>WELCOME-10</strong>");
    // after an earlier reminder it is the final one, as before
    expect(html(true).subject).toBe(
      "Your Pirate Island preview: a final reminder"
    );
    // and a middle send never carries the extras, whatever alreadyReminded says
    const middle = renderReminderEmail(
      base({
        step: 1,
        deletionDate: "17 November 2026",
        couponCode: "WELCOME-10",
        alreadyReminded: false,
      })
    );
    expect(middle.html).not.toContain("WELCOME-10");
  });

  it("the same for the book reminder: its first mail is never a final reminder", () => {
    const fresh = renderReminderEmail(
      base({ kind: "BOOK_NOT_SENT", step: 2, alreadyReminded: false })
    );
    expect(fresh.subject).not.toContain("final reminder");
  });

  it("a single send uses the first wording, never 'final reminder'", () => {
    const only = renderReminderEmail(base({ step: 0, total: 1 }));
    expect(only.subject).toBe("Your Pirate Island story preview is waiting");
  });

  it("without a cover there is no image", () => {
    expect(renderReminderEmail(base({ coverUrl: null })).html).not.toContain(
      "<img"
    );
  });

  it("the deletion date and the coupon appear only in the last send, and only when given", () => {
    const withBoth = {
      deletionDate: "17 November 2026",
      couponCode: "WELCOME-10",
    };
    const last = renderReminderEmail(base({ step: 2, ...withBoth })).html;
    expect(last).toContain("deleted on <strong>17 November 2026</strong>");
    expect(last).toContain("<strong>WELCOME-10</strong>");
    for (const step of [0, 1]) {
      const early = renderReminderEmail(base({ step, ...withBoth })).html;
      expect(early).not.toContain("17 November 2026");
      expect(early).not.toContain("WELCOME-10");
    }
    const none = renderReminderEmail(base({ step: 2 })).html;
    expect(none).not.toContain("deleted on");
    expect(none).not.toContain("code");
  });

  it("escapes the coupon code and the date", () => {
    const html = renderReminderEmail(
      base({ step: 2, deletionDate: "<x>", couponCode: "A&B" })
    ).html;
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("A&amp;B");
  });
});

describe("B, the book not sent to print", () => {
  const kind = "BOOK_NOT_SENT" as const;

  it("is only about the order: no cover, coupon, deletion date or review ask, even if passed in", () => {
    for (const step of [0, 1, 2]) {
      const { html } = renderReminderEmail(
        base({
          kind,
          step,
          deletionDate: "1 January 2027",
          couponCode: "SECRET-5",
        })
      );
      expect(html).not.toContain("<img");
      expect(html).not.toContain("SECRET-5");
      expect(html).not.toContain("1 January 2027");
      expect(html).not.toContain("short review");
      expect(html).not.toContain("Leave a Review");
    }
  });

  it("says nothing is printed until Send to Print, except the last send which offers help", () => {
    const first = renderReminderEmail(base({ kind, step: 0 })).html;
    const last = renderReminderEmail(base({ kind, step: 2 })).html;
    expect(first).toContain("We will not print anything until you press");
    expect(last).toContain("contact us using the details below");
    expect(first).toContain("Review the Full Book");
  });

  it("its footer is the per-book stop link, not the general unsubscribe wording", () => {
    const { html } = renderReminderEmail(base({ kind }));
    expect(html).toContain("Stop reminders about this book");
    expect(html).toContain("This reminder is about your order.");
    expect(html).not.toContain("Stop these emails");
  });
});

describe("C, the review request", () => {
  const kind = "REVIEW_REQUEST" as const;

  it("has one link, no promotion, and a short follow-up", () => {
    const first = renderReminderEmail(base({ kind, step: 0, total: 2 }));
    const second = renderReminderEmail(base({ kind, step: 1, total: 2 }));
    expect(first.subject).toBe("How was your Pirate Island book?");
    expect(second.subject).toBe("A small favour, if you have a minute");
    for (const mail of [first, second]) {
      expect(mail.html).not.toContain("<img");
      expect(mail.html.match(/<a href=/g)?.length).toBeGreaterThanOrEqual(2); // button, stop link, support links
      expect(mail.html).toContain("Leave a Review");
      expect(mail.html).not.toContain("discount");
      expect(mail.html).not.toContain("coupon");
    }
  });

  it("each text stays under about 100 words before the footer", () => {
    const { html } = renderReminderEmail(base({ kind, step: 0, total: 2 }));
    const start = html.indexOf("<p>Hi,</p>");
    const end = html.indexOf("You are receiving this");
    const text = html
      .slice(start, end)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    expect(text.split(" ").length).toBeLessThan(100);
  });
});
