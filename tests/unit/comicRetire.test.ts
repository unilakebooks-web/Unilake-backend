import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));

import { monthRuleReason } from "../../src/services/comicRetire.service.js";
import { ComicStatus } from "../../src/generated/prisma/client.js";

const S = 1000;
const H = 60 * 60 * S;
const D = 24 * H;
const NOW = new Date("2026-11-21T12:00:00.000Z");
const unpublishedAgo = (ms: number) => new Date(NOW.getTime() - ms);

describe("monthRuleReason", () => {
  it("UNPUBLISHED 29 days 23 hours ago is refused, naming the 30 days", () => {
    const reason = monthRuleReason(
      { status: "UNPUBLISHED", unpublishedAt: unpublishedAgo(29 * D + 23 * H) },
      NOW
    );
    expect(reason).toMatch(/30 days after it was unpublished/);
  });
  it("UNPUBLISHED one second short of 30 days is refused", () => {
    expect(
      monthRuleReason(
        { status: "UNPUBLISHED", unpublishedAt: unpublishedAgo(30 * D - S) },
        NOW
      )
    ).not.toBeNull();
  });
  it("UNPUBLISHED exactly 30 days ago may go ahead", () => {
    expect(
      monthRuleReason(
        { status: "UNPUBLISHED", unpublishedAt: unpublishedAgo(30 * D) },
        NOW
      )
    ).toBeNull();
  });
  it("UNPUBLISHED 31 days ago may go ahead", () => {
    expect(
      monthRuleReason(
        { status: "UNPUBLISHED", unpublishedAt: unpublishedAgo(31 * D) },
        NOW
      )
    ).toBeNull();
  });
  it("UNPUBLISHED with no date is refused with its own reason", () => {
    expect(
      monthRuleReason({ status: "UNPUBLISHED", unpublishedAt: null }, NOW)
    ).toBe("it has no unpublish date yet, so it cannot be deleted");
  });
  it("the reason names the first allowed day (unpublish date plus 30 days, in IST)", () => {
    // 2026-11-10 20:00 UTC + 30 days = 2026-12-10 20:00 UTC = 11 December 2026, 01:30 IST
    const reason = monthRuleReason(
      {
        status: "UNPUBLISHED",
        unpublishedAt: new Date("2026-11-10T20:00:00.000Z"),
      },
      new Date("2026-11-20T00:00:00.000Z")
    );
    expect(reason).toContain("11 December 2026");
  });

  it("a never-published DRAFT (no date) is unchanged: null", () => {
    expect(
      monthRuleReason({ status: "DRAFT", unpublishedAt: null }, NOW)
    ).toBeNull();
  });
  it("a DRAFT that was published once and unpublished recently is refused", () => {
    expect(
      monthRuleReason(
        { status: "DRAFT", unpublishedAt: unpublishedAgo(29 * D + 23 * H) },
        NOW
      )
    ).toMatch(/30 days/);
  });
  it("a DRAFT with a date 30 days old may go ahead", () => {
    expect(
      monthRuleReason(
        { status: "DRAFT", unpublishedAt: unpublishedAgo(30 * D) },
        NOW
      )
    ).toBeNull();
  });

  // One explicit cell per status, with a date one hour ago: only UNPUBLISHED and a dated DRAFT are held.
  const WITH_RECENT_DATE: Record<ComicStatus, "held" | "free"> = {
    DRAFT: "held",
    PUBLISHING: "free",
    PUBLISHED: "free",
    UNPUBLISHED: "held",
  };
  it("covers every ComicStatus exactly", () => {
    expect(Object.keys(WITH_RECENT_DATE).sort()).toEqual(
      Object.values(ComicStatus).sort()
    );
  });
  for (const [status, expected] of Object.entries(WITH_RECENT_DATE)) {
    it(`${status} with a date one hour ago is ${expected}`, () => {
      const reason = monthRuleReason(
        { status: status as ComicStatus, unpublishedAt: unpublishedAgo(H) },
        NOW
      );
      if (expected === "held") expect(reason).toMatch(/30 days/);
      else expect(reason).toBeNull();
    });
    it(`${status} with no date is ${status === "UNPUBLISHED" ? "refused" : "free"}`, () => {
      const reason = monthRuleReason(
        { status: status as ComicStatus, unpublishedAt: null },
        NOW
      );
      if (status === "UNPUBLISHED") expect(reason).toMatch(/no unpublish date/);
      else expect(reason).toBeNull();
    });
  }
});
