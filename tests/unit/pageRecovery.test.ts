import { describe, expect, it } from "vitest";
import {
  classifyPage,
  cleanErrorText,
  orderRule,
  type JobState,
  type PageRow,
} from "../../src/utils/pageRecovery.js";
import type { PageVersionStatus } from "../../src/generated/prisma/client.js";

const NOW = new Date("2026-11-17T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

let seq = 0;
const row = (
  status: PageVersionStatus,
  minutesAgo: number,
  variantIndex = 0,
  errorMessage: string | null = null
): PageRow => ({
  id: `row-${++seq}`,
  variantIndex,
  status,
  updatedAt: ago(minutesAgo),
  errorMessage,
});

const classify = (
  rows: PageRow[],
  job: JobState = "missing",
  isPreviewPage = false
) => classifyPage({ isPreviewPage, rows, jobStateOf: () => job }, NOW);

describe("classifyPage: pages with no row, and failed pages", () => {
  it("a paid page with no row is NOT_STARTED and restartable, by creating variant 0", () => {
    const c = classify([]);
    expect(c).toMatchObject({
      state: "NOT_STARTED",
      needsRow: true,
      restartable: true,
    });
  });

  it("a free preview page with no row is not restartable (not part of what was paid for)", () => {
    expect(classify([], "missing", true)).toMatchObject({
      state: "NOT_STARTED",
      restartable: false,
    });
  });

  it("a page whose only row failed 3 minutes ago is FAILED, in cooldown: needs Restart anyway", () => {
    const failed = row("FAILED", 3);
    const c = classify([failed]);
    expect(c).toMatchObject({
      state: "FAILED",
      targetRowId: failed.id,
      restartable: true,
      requiresForce: true,
    });
    expect(c.cooldownEndsAt?.getTime()).toBe(ago(3).getTime() + 10 * 60 * 1000);
  });

  it("a page that failed 10 minutes ago or more restarts without force", () => {
    for (const minutes of [10, 11, 600]) {
      const c = classify([row("FAILED", minutes)]);
      expect(c).toMatchObject({
        state: "FAILED",
        restartable: true,
        requiresForce: false,
        cooldownEndsAt: null,
      });
    }
  });

  it("restarts the newest failed row, not an older one", () => {
    const older = row("FAILED", 60, 0);
    const newer = row("FAILED", 60, 1);
    expect(classify([older, newer]).targetRowId).toBe(newer.id);
    expect(classify([newer, older]).targetRowId).toBe(newer.id);
  });
});

describe("classifyPage: finished pages", () => {
  it("a finished page is READY and untouched, even when a newer variant failed", () => {
    const c = classify([row("SD_READY", 90, 0), row("FAILED", 90, 1)]);
    expect(c).toMatchObject({
      state: "READY",
      restartable: false,
      targetRowId: null,
    });
  });

  it("a finished page shows no error, even if a newer variant of it failed", () => {
    const c = classify([
      row("SD_READY", 90, 0),
      row("FAILED", 90, 1, "RunPod said no"),
    ]);
    expect(c).toMatchObject({ state: "READY", lastError: null });
  });

  it("a finished page with a newer retry that is stuck is BLOCKED and that retry is restartable", () => {
    const stuck = row("QUEUED", 5, 1);
    const c = classify([row("SD_READY", 90, 0), stuck]);
    expect(c).toMatchObject({
      state: "BLOCKED",
      restartable: true,
      targetRowId: stuck.id,
    });
  });

  it("a finished page with a retry that is running stays READY and is not restartable", () => {
    const c = classify(
      [row("SD_READY", 90, 0), row("GENERATING_SD", 1, 1)],
      "active"
    );
    expect(c).toMatchObject({
      state: "READY",
      restartable: false,
      retryRunning: true,
    });
  });
});

describe("classifyPage: rows in flight", () => {
  it("an active job is IN_PROGRESS and left alone, whatever its age under 30 minutes", () => {
    for (const minutes of [0, 1, 15, 29]) {
      const c = classify([row("GENERATING_SD", minutes)], "active");
      expect(c).toMatchObject({ state: "IN_PROGRESS", restartable: false });
    }
  });

  it("an active job whose row was untouched for 30 minutes is restartable only with Restart anyway", () => {
    const c = classify([row("GENERATING_SD", 31)], "active");
    expect(c).toMatchObject({
      state: "IN_PROGRESS",
      restartable: true,
      requiresForce: true,
      removeJob: true,
    });
  });

  it("delayed and waiting-children jobs follow the active rule", () => {
    for (const job of ["delayed", "waiting-children"] as const) {
      expect(classify([row("QUEUED", 5)], job)).toMatchObject({
        state: "IN_PROGRESS",
        restartable: false,
      });
      expect(classify([row("QUEUED", 45)], job)).toMatchObject({
        restartable: true,
        requiresForce: true,
      });
    }
  });

  it("a waiting or prioritized job is WAITING for 10 minutes, then STUCK and restartable (the job is removed)", () => {
    for (const job of ["waiting", "prioritized"] as const) {
      expect(classify([row("QUEUED", 9)], job)).toMatchObject({
        state: "WAITING",
        restartable: false,
      });
      expect(classify([row("QUEUED", 10)], job)).toMatchObject({
        state: "STUCK",
        restartable: true,
        requiresForce: false,
        removeJob: true,
      });
    }
  });

  it("a row with no job is alive for 2 minutes, then STUCK", () => {
    expect(classify([row("QUEUED", 1)])).toMatchObject({
      state: "IN_PROGRESS",
      restartable: false,
    });
    expect(classify([row("QUEUED", 2)])).toMatchObject({
      state: "STUCK",
      restartable: true,
    });
  });

  it("a stuck row that never reached the image service restarts with no cooldown", () => {
    for (const status of ["QUEUED", "TEXT_STAMPING", "TEXT_STAMPED"] as const) {
      const c = classify([row(status, 3)]);
      expect(c).toMatchObject({
        state: "STUCK",
        restartable: true,
        requiresForce: false,
        cooldownEndsAt: null,
      });
    }
  });

  it("a stuck GENERATING_SD row may still be running at RunPod: 10 minutes of cooldown", () => {
    const c = classify([row("GENERATING_SD", 3)]);
    expect(c).toMatchObject({
      state: "STUCK",
      restartable: true,
      requiresForce: true,
    });
    expect(c.cooldownEndsAt?.getTime()).toBe(ago(3).getTime() + 10 * 60 * 1000);
    expect(classify([row("GENERATING_SD", 10)])).toMatchObject({
      requiresForce: false,
      cooldownEndsAt: null,
    });
  });

  it("a row whose job failed is held back like a RunPod row; a completed job is not", () => {
    expect(classify([row("QUEUED", 3)], "failed")).toMatchObject({
      requiresForce: true,
    });
    expect(classify([row("QUEUED", 3)], "completed")).toMatchObject({
      restartable: true,
      requiresForce: false,
    });
  });

  it("when the queue cannot be asked nothing in flight is called stuck", () => {
    const c = classify([row("QUEUED", 500)], "unavailable");
    expect(c).toMatchObject({ state: "IN_PROGRESS", restartable: false });
  });

  it("the newest in-flight row decides, not an older failed one", () => {
    const failed = row("FAILED", 60, 0);
    const running = row("GENERATING_SD", 1, 1);
    expect(classify([failed, running], "active")).toMatchObject({
      state: "IN_PROGRESS",
      targetRowId: running.id,
    });
  });
});

describe("cleanErrorText", () => {
  it("removes links, collapses spaces and cuts to 200 characters", () => {
    expect(
      cleanErrorText("failed at https://r2.example.com/x/y.png?sig=1  twice")
    ).toBe("failed at [link] twice");
    const cut = cleanErrorText("x".repeat(500))!;
    expect(cut.length).toBe(201);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("is null for nothing", () => {
    expect(cleanErrorText(null)).toBeNull();
    expect(cleanErrorText("   ")).toBeNull();
  });
});

describe("orderRule", () => {
  const order = (status: string, extra: Record<string, unknown> = {}) =>
    ({ status, pdfUrl: null, updatedAt: ago(60), ...extra }) as never;

  it("allows the states a stuck paid book can be in", () => {
    expect(orderRule(order("PAID"), "GENERATING_PAID", NOW)).toMatchObject({
      canRegenerate: true,
      mode: "plain",
    });
    expect(
      orderRule(order("GENERATED"), "PAID_PAGES_READY", NOW)
    ).toMatchObject({ canRegenerate: true, mode: "plain" });
    for (const s of [
      "FAILED",
      "PREVIEW_READY",
      "GENERATING_PREVIEW",
    ] as const) {
      expect(orderRule(order("PAID"), s, NOW)).toMatchObject({
        canRegenerate: true,
        mode: "restore",
      });
    }
  });

  it("(PAID, PAID) is still processing for 10 minutes, then actionable", () => {
    const young = orderRule(order("PAID", { updatedAt: ago(5) }), "PAID", NOW);
    expect(young).toMatchObject({ canRegenerate: false });
    expect(young.blockedReason).toMatch(/still being processed/);
    expect(
      orderRule(order("PAID", { updatedAt: ago(10) }), "PAID", NOW)
    ).toMatchObject({ canRegenerate: true, mode: "stalled" });
  });

  it("refuses an unpaid, cancelled or already printed order, and a pdf of any order", () => {
    expect(
      orderRule(order("CREATED"), "AWAITING_PAYMENT", NOW).blockedReason
    ).toMatch(/not been paid/);
    expect(orderRule(order("CANCELLED"), "FAILED", NOW).blockedReason).toMatch(
      /cancelled/
    );
    for (const s of [
      "CONFIRMED",
      "SHIPROCKET_FAILED",
      "READY_TO_SHIP",
      "SHIPPED",
      "DELIVERED",
    ]) {
      expect(orderRule(order(s), "CONFIRMED", NOW).blockedReason).toMatch(
        /frozen/
      );
    }
    expect(
      orderRule(
        order("GENERATED", { pdfUrl: "x.pdf" }),
        "PAID_PAGES_READY",
        NOW
      ).blockedReason
    ).toMatch(/frozen/);
  });

  it("any other pair is inconsistent", () => {
    expect(orderRule(order("PAID"), "COMPLETED", NOW).blockedReason).toMatch(
      /inconsistent/
    );
    expect(orderRule(order("GENERATED"), "FAILED", NOW).blockedReason).toMatch(
      /inconsistent/
    );
  });
});
