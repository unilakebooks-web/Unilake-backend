import "../setup/env.js";
import { describe, it, expect, vi } from "vitest";

// The rules of the view-only share link (feature 14) that need no database: the token shape, the "gone" rule,
// the variant choice and the image key rule. The database, the queues and the logger are replaced; the storage
// client is only built, never used. The configured public base is the test environment's (see sharedImageKey tests).
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {},
  shiprocketQueue: {},
  pdfCompilationQueue: {},
}));

import {
  isSessionGone,
  isShareToken,
  pickShareVariant,
  sharedImageKey,
  type ShareSessionFacts,
} from "../../src/services/share.service.js";
import { config } from "../../src/config/env.js";
import { createShareSchema } from "../../src/validators/share.schema.js";

const SESSION = "0b8e2c4a-1d3f-4a5b-8c6d-7e9f0a1b2c3d";
const OTHER = "9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f";

describe("share token shape", () => {
  const good = "A".repeat(32);
  it("accepts exactly 32 URL-safe characters", () => {
    expect(isShareToken(good)).toBe(true);
    expect(isShareToken("abc_DEF-0123456789abcdefghijklmn")).toBe(true);
  });
  it("refuses 31 and 33 characters, other characters, a trailing newline, a session id and non-strings", () => {
    expect(isShareToken("A".repeat(31))).toBe(false);
    expect(isShareToken("A".repeat(33))).toBe(false);
    expect(isShareToken("A".repeat(31) + "+")).toBe(false);
    expect(isShareToken("A".repeat(31) + "\n")).toBe(false);
    expect(isShareToken(SESSION)).toBe(false);
    expect(isShareToken(undefined)).toBe(false);
    expect(isShareToken(["x"])).toBe(false);
    expect(isShareToken("")).toBe(false);
  });
});

describe("share body schema", () => {
  it("allows no body and {}", () => {
    expect(createShareSchema.safeParse(undefined).success).toBe(true);
    expect(createShareSchema.safeParse({}).success).toBe(true);
  });
  it("allows a boolean showName only", () => {
    expect(createShareSchema.safeParse({ showName: true }).success).toBe(true);
    expect(createShareSchema.safeParse({ showName: false }).success).toBe(true);
    for (const bad of [
      "true",
      1,
      null,
      [],
      { showName: "yes" },
      { showName: true, extra: 1 },
      { other: 1 },
    ]) {
      expect(createShareSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("isSessionGone", () => {
  // Written out by hand, not taken from the code: the statuses that never expire.
  const EXEMPT = [
    "AWAITING_PAYMENT",
    "PAID",
    "GENERATING_PAID",
    "PAID_PAGES_READY",
    "CONFIRMED",
    "COMPILING_PDF",
    "PDF_FAILED",
    "SHIPMENT_QUEUED",
    "SHIPMENT_FAILED",
    "COMPLETED",
  ];
  const ALL = [
    "CREATED",
    "PHOTO_UPLOADED",
    "GENERATING_PREVIEW",
    "PREVIEW_READY",
    ...EXEMPT,
    "FAILED",
  ] as const;
  const ORDERS = [null, "CREATED", "PAID", "CANCELLED", "DELIVERED"] as const;
  const NOW = new Date("2026-11-21T10:00:00.000Z");
  const EXPIRIES = {
    before: new Date(NOW.getTime() + 1),
    at: new Date(NOW.getTime()),
    after: new Date(NOW.getTime() - 1),
  } as const;
  const MARKS = {
    none: [null, null],
    photo: [new Date("2026-11-20T00:00:00Z"), null],
    files: [null, new Date("2026-11-20T00:00:00Z")],
    both: [new Date("2026-11-20T00:00:00Z"), new Date("2026-11-20T00:00:00Z")],
  } as const;

  it("walks every status x order x expiry x marker cell against the written rule", () => {
    expect(ALL.length).toBe(15);
    let cells = 0;
    for (const status of ALL) {
      for (const order of ORDERS) {
        for (const [expiryName, expiresAt] of Object.entries(EXPIRIES)) {
          for (const [
            markName,
            [photoDeletedAt, filesDeletedAt],
          ] of Object.entries(MARKS)) {
            const facts: ShareSessionFacts = {
              status: status as ShareSessionFacts["status"],
              expiresAt,
              isSample: false,
              photoDeletedAt,
              filesDeletedAt,
              order: order ? { status: order } : null,
            };
            const unpaid = order === null || order === "CREATED";
            const expired = expiryName === "after" && !EXEMPT.includes(status);
            const expected =
              markName === "files" ||
              markName === "both" ||
              (markName === "photo" && unpaid) ||
              expired;
            expect(
              isSessionGone(facts, NOW),
              `${status}/${order}/${expiryName}/${markName}`
            ).toBe(expected);
            cells += 1;
          }
        }
      }
    }
    expect(cells).toBe(15 * 5 * 3 * 4);
  });

  it("treats an expiry equal to now as alive and one millisecond earlier as gone", () => {
    const base: ShareSessionFacts = {
      status: "PREVIEW_READY",
      expiresAt: NOW,
      isSample: false,
      photoDeletedAt: null,
      filesDeletedAt: null,
      order: null,
    };
    expect(isSessionGone(base, NOW)).toBe(false);
    expect(
      isSessionGone({ ...base, expiresAt: new Date(NOW.getTime() - 1) }, NOW)
    ).toBe(true);
  });

  it("never shares a sample", () => {
    expect(
      isSessionGone(
        {
          status: "PREVIEW_READY",
          expiresAt: new Date(NOW.getTime() + 1e9),
          isSample: true,
          photoDeletedAt: null,
          filesDeletedAt: null,
          order: null,
        },
        NOW
      )
    ).toBe(true);
  });

  it("keeps a paid book shareable when only its photo was deleted (the pages still exist)", () => {
    expect(
      isSessionGone(
        {
          status: "COMPLETED",
          expiresAt: new Date(NOW.getTime() - 1e9),
          isSample: false,
          photoDeletedAt: new Date(),
          filesDeletedAt: null,
          order: { status: "DELIVERED" },
        },
        NOW
      )
    ).toBe(false);
  });
});

describe("pickShareVariant", () => {
  it("returns null for nothing", () => {
    expect(pickShareVariant([])).toBeNull();
  });
  it("prefers the selected (printed) variant even when it is not the highest", () => {
    const v = [
      { id: "a", isSelected: true, variantIndex: 0 },
      { id: "b", isSelected: false, variantIndex: 3 },
    ];
    expect(pickShareVariant(v)?.id).toBe("a");
  });
  it("otherwise takes the highest variant number", () => {
    const v = [
      { id: "a", isSelected: false, variantIndex: 1 },
      { id: "b", isSelected: false, variantIndex: 4 },
      { id: "c", isSelected: false, variantIndex: 2 },
    ];
    expect(pickShareVariant(v)?.id).toBe("b");
  });
});

describe("sharedImageKey", () => {
  const base = config.r2.publicUrlBase.replace(/\/$/, "");
  const ok = `${base}/sessions/${SESSION}/final/0123abcd-ef01.webp`;
  it("accepts a web image inside the session's final folder", () => {
    expect(sharedImageKey(SESSION, ok)).toBe(
      `sessions/${SESSION}/final/0123abcd-ef01.webp`
    );
  });
  it("accepts the same key on the r2.dev and images hosts", () => {
    expect(
      sharedImageKey(
        SESSION,
        `https://pub-abc.r2.dev/sessions/${SESSION}/final/x.webp`
      )
    ).toBe(`sessions/${SESSION}/final/x.webp`);
    expect(
      sharedImageKey(
        SESSION,
        `https://images.unilakekids.com/sessions/${SESSION}/final/x.webp`
      )
    ).toBe(`sessions/${SESSION}/final/x.webp`);
  });
  it("refuses everything else", () => {
    const refused = [
      `${base}/sessions/${OTHER}/final/x.webp`, // another session
      `${base}/sessions/${SESSION}/x.webp`, // not in final/
      `${base}/sessions/${SESSION}/photo-1.webp`,
      `${base}/sessions/${SESSION}/final/x.png`, // print master or other format
      `${base}/sessions/${SESSION}/final/x.WEBP`,
      `${base}/sessions/${SESSION}/final/x.svg`,
      `${base}/sessions/${SESSION}/final/x.webp.html`,
      `${base}/sessions/${SESSION}/final/x`,
      `${base}/sessions/${SESSION}/final/x.`,
      `${base}/sessions/${SESSION}/final/x.webp?x=1`, // a query
      `${base}/sessions/${SESSION}/final/../../${OTHER}/final/x.webp`,
      `${base}/sessions/${SESSION}/final/%2e%2e/x.webp`,
      `${base}/sessions/${SESSION}/final/..webp`,
      `${base}/sessions/${SESSION}/final/a/b.webp`, // a nested path
      `${base}/pdfs/${SESSION}.pdf`,
      `${base}/comics/x/y.webp`,
      `https://evil.example/sessions/${SESSION}/final/x.webp`, // not one of our hosts
      `https://pub-abc.r2.dev/sessions/${SESSION}/final/%zz.webp`, // a malformed escape
      "not a url",
      "",
    ];
    for (const url of refused)
      expect(sharedImageKey(SESSION, url), url).toBeNull();
  });
});
