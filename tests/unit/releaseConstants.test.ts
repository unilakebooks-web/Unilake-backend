import "../setup/env.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Release 4 joins three features whose constants lean on each other: the reminders must stay inside the time the
// files are kept (feature 6), the share link's token shape is repeated in the frontend (feature 14), and the order
// of the scheduled sweeps carries a promise. Each test pins one coupling, so a later change to one side cannot
// silently break the other. The database, the logger and every sweep are replaced.
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const db = vi.hoisted(() => ({
  orderSession: { findUnique: vi.fn() },
  sessionShare: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {},
  shiprocketQueue: {},
  pdfCompilationQueue: {},
}));
const sweeps = vi.hoisted(() => ({
  sessions: vi.fn(),
  pages: vi.fn(),
  coupons: vi.fn(),
  samples: vi.fn(),
  deletion: vi.fn(),
  reminders: vi.fn(),
  broadcasts: vi.fn(),
}));
vi.mock("../../src/services/coupon.service.js", () => ({
  sweepExpiredCoupons: sweeps.coupons,
}));
vi.mock("../../src/jobs/workers/stuckPageSweeper.js", () => ({
  sweepStuckPageVersions: sweeps.pages,
}));
vi.mock("../../src/jobs/workers/sampleSweeper.js", () => ({
  sweepSampleSessions: sweeps.samples,
}));
vi.mock("../../src/services/dataDeletion.service.js", () => ({
  sweepDataDeletion: sweeps.deletion,
}));
vi.mock("../../src/services/reminder.service.js", () => ({
  sweepReminders: sweeps.reminders,
}));
vi.mock("../../src/services/broadcast.service.js", () => ({
  sweepBroadcasts: sweeps.broadcasts,
}));
// session.service.js is shared by the sweeps and the share service: one mock gives both what they import.
vi.mock("../../src/services/session.service.js", () => ({
  sweepExpiredSessions: sweeps.sessions,
  EXPIRY_EXEMPT_STATUSES: [],
}));

import {
  CATCH_UP_WINDOW_MS,
  HOUR_MS,
  MAX_OFFSET_HOURS,
  MAX_PREVIEW_DELETION_DAYS,
} from "../../src/config/reminders.js";
import {
  BOOK_DELETION_DAYS,
  DAY_MS,
  PREVIEW_DELETION_DELAY_MS,
} from "../../src/config/dataDeletion.js";
import { SHARE_TOKEN_SHAPE } from "../../src/config/share.js";
import { createOrGetShare } from "../../src/services/share.service.js";
import { runScheduledSweeps } from "../../src/services/scheduledSweeps.service.js";

const root = resolve(__dirname, "../..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("reminders versus data deletion", () => {
  it("reminder C's largest send time plus the catch-up window is before the day the book's pages are deleted", () => {
    const latestCMs =
      MAX_OFFSET_HOURS.REVIEW_REQUEST * 3_600_000 + CATCH_UP_WINDOW_MS;
    expect(latestCMs).toBeLessThan(BOOK_DELETION_DAYS * DAY_MS);
    // pinned values, so a change to either side shows up here with the number
    expect(MAX_OFFSET_HOURS.REVIEW_REQUEST).toBe(40 * 24);
    expect(BOOK_DELETION_DAYS).toBe(45);
  });

  it("reminder B's largest send time plus the catch-up window is before the pages are deleted too", () => {
    expect(
      MAX_OFFSET_HOURS.BOOK_NOT_SENT * HOUR_MS + CATCH_UP_WINDOW_MS
    ).toBeLessThan(BOOK_DELETION_DAYS * DAY_MS);
  });

  it("reminder A's largest send time plus the catch-up window fits inside the preview's 7 day life, so 'kept until' is never about a deleted preview", () => {
    const lifetimeDays = Number(
      /const SESSION_LIFETIME_DAYS = (\d+);/.exec(
        source("src/services/session.service.ts")
      )?.[1]
    );
    expect(lifetimeDays).toBe(7);
    expect(
      MAX_OFFSET_HOURS.PREVIEW_UNFINISHED * HOUR_MS + CATCH_UP_WINDOW_MS
    ).toBeLessThanOrEqual(lifetimeDays * DAY_MS);
    // the admin's promise cap in the reminder settings is the same 7 days
    expect(MAX_PREVIEW_DELETION_DAYS).toBe(lifetimeDays);
    // an unpaid preview is deleted only after it expired, and the last reminder is sent before it
    expect(PREVIEW_DELETION_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("the scheduled sweeps", () => {
  beforeEach(() => {
    for (const fn of Object.values(sweeps)) fn.mockReset().mockResolvedValue(0);
  });

  it("run in the order the privacy promise and the email budget need: seven sweeps, deletion before the emails, broadcasts last", async () => {
    const { results } = await runScheduledSweeps();
    expect(results.map((r) => r.name)).toEqual([
      "expired sessions",
      "stuck pages",
      "expired coupons",
      "sample books",
      "data deletion",
      "reminder emails",
      "broadcast emails",
    ]);
    expect(results).toHaveLength(7);
  });
});

describe("the share token", () => {
  it("a token the service creates matches the shape the config accepts and the 32 characters the frontend repeats", async () => {
    db.orderSession.findUnique.mockResolvedValue({
      id: "s1",
      status: "PREVIEW_READY",
      expiresAt: new Date(Date.now() + 86_400_000),
      isSample: false,
      photoDeletedAt: null,
      filesDeletedAt: null,
      order: null,
    });
    db.sessionShare.findUnique.mockResolvedValue(null);
    db.sessionShare.create.mockImplementation(
      async ({ data }: { data: object }) => ({ ...data, revokedAt: null })
    );
    const { token } = await createOrGetShare("s1", undefined);
    expect(token).toHaveLength(32);
    expect(SHARE_TOKEN_SHAPE.test(token)).toBe(true);
    // the shape itself is exactly 32 characters
    expect(SHARE_TOKEN_SHAPE.test(token + "A")).toBe(false);
    expect(SHARE_TOKEN_SHAPE.test(token.slice(1))).toBe(false);
    expect(SHARE_TOKEN_SHAPE.source).toContain("{32}");
  });
});
