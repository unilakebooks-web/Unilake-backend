import { describe, it, expect, vi } from "vitest";

// The selection module imports prisma, r2 and the session service; the functions under test are pure, so the
// database, storage and queue modules are replaced. The session service itself is the real one: the exempt list
// below is read from it, so a change to EXPIRY_EXEMPT_STATUSES is followed by these tests (and fails them if the
// change was not meant to reach deletion).
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/r2.js", () => ({
  pdfKeyFor: (id: string) => `pdfs/${id}.pdf`,
}));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {},
  shiprocketQueue: {},
  pdfCompilationQueue: {},
}));

import {
  r1Decision,
  deliveredDecision,
  isLiveVersionStatus,
  type R1Session,
} from "../../src/services/dataDeletionSelect.service.js";
import {
  OrderStatus,
  OrderSessionStatus,
  PageVersionStatus,
} from "../../src/generated/prisma/client.js";

const S = 1000;
const H = 60 * 60 * S;
const D = 24 * H;
const NOW = new Date("2026-11-21T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

type SessionOver = Partial<Omit<R1Session, "order">> & {
  order?: Partial<NonNullable<R1Session["order"]>> | null;
};

/** A session whose R1 clock is well past due and whose order (if any) is old: eligible unless a test changes it. */
function session(over: SessionOver = {}): R1Session {
  const { order, ...rest } = over;
  return {
    id: "s1",
    status: "PREVIEW_READY",
    isSample: false,
    filesDeletedAt: null,
    expiresAt: at(-10 * D),
    pageVersions: [],
    order:
      order === null
        ? null
        : order === undefined
          ? null
          : {
              status: "CREATED",
              updatedAt: at(-9 * D),
              razorpayPaymentId: null,
              billNumber: null,
              couponRedemption: null,
              ...order,
            },
    ...rest,
  };
}

describe("r1Decision: the expiry clock", () => {
  // expiresAt is placed so that `now` is exactly `offset` from expiresAt + 1 hour.
  const withClock = (offsetMs: number) =>
    session({ expiresAt: at(-H - offsetMs) });

  it("is not due one second before expiresAt + 1 hour", () => {
    expect(r1Decision(withClock(-S), NOW)).toMatchObject({
      eligible: false,
      reason: "not_due",
    });
  });
  it("is due exactly at expiresAt + 1 hour", () => {
    expect(r1Decision(withClock(0), NOW)).toMatchObject({
      eligible: true,
      reason: "no_order",
    });
  });
  it("is due one second after expiresAt + 1 hour", () => {
    expect(r1Decision(withClock(S), NOW).eligible).toBe(true);
  });
  it("is not due while the session has not even expired", () => {
    expect(r1Decision(session({ expiresAt: at(D) }), NOW).reason).toBe(
      "not_due"
    );
  });
});

describe("r1Decision: the 2-day order clock and the 3-day cap", () => {
  // The order was last touched `ageMs` ago; the session expired `sinceExpiryMs` ago.
  const created = (ageMs: number, sinceExpiryMs: number) =>
    session({
      expiresAt: at(-sinceExpiryMs),
      order: { updatedAt: at(-ageMs) },
    });

  it("holds a CREATED order touched one second less than 2 days ago", () => {
    expect(r1Decision(created(2 * D - S, 2.5 * D), NOW)).toMatchObject({
      eligible: false,
      reason: "order_recently_touched",
      pastCap: false,
    });
  });
  it("releases a CREATED order touched exactly 2 days ago", () => {
    expect(r1Decision(created(2 * D, 2.5 * D), NOW)).toEqual({
      eligible: true,
      reason: "created_order",
      needsPaymentCheck: true,
      pastCap: false,
    });
  });
  it("releases a CREATED order touched 2 days and one second ago", () => {
    expect(r1Decision(created(2 * D + S, 2.5 * D), NOW).eligible).toBe(true);
  });
  it("is not past the cap one second before expiresAt + 3 days", () => {
    const d = r1Decision(created(0, 3 * D - S), NOW);
    expect(d).toMatchObject({
      eligible: false,
      reason: "order_recently_touched",
      pastCap: false,
    });
  });
  it("is past the cap exactly at expiresAt + 3 days, and then the 2-day clock no longer holds", () => {
    expect(r1Decision(created(0, 3 * D), NOW)).toEqual({
      eligible: true,
      reason: "created_order",
      needsPaymentCheck: true,
      pastCap: true,
    });
  });
  it("is past the cap one second after expiresAt + 3 days", () => {
    expect(r1Decision(created(0, 3 * D + S), NOW)).toMatchObject({
      eligible: true,
      pastCap: true,
    });
  });
  it("still refuses a payment id, bill number or redeemed coupon past the cap", () => {
    const over = (order: SessionOver["order"]) =>
      r1Decision(
        session({
          expiresAt: at(-30 * D),
          order: { updatedAt: at(-30 * D), ...order },
        }),
        NOW
      );
    expect(over({ razorpayPaymentId: "pay_1" }).reason).toBe("payment_id");
    expect(over({ billNumber: "B-1" }).reason).toBe("bill_number");
    expect(over({ couponRedemption: { status: "REDEEMED" } }).reason).toBe(
      "coupon_redeemed"
    );
  });
});

describe("r1Decision: the flags and the money fields", () => {
  it("refuses a sample", () => {
    expect(r1Decision(session({ isSample: true }), NOW)).toEqual({
      eligible: false,
      reason: "sample",
      needsPaymentCheck: false,
      pastCap: false,
    });
  });
  it("refuses a session that is already marked", () => {
    expect(r1Decision(session({ filesDeletedAt: at(-D) }), NOW).reason).toBe(
      "already_marked"
    );
  });
  it("checks sample before the clock", () => {
    expect(
      r1Decision(session({ isSample: true, expiresAt: at(D) }), NOW).reason
    ).toBe("sample");
  });
  it("refuses a Razorpay payment id on a CREATED order", () => {
    expect(
      r1Decision(session({ order: { razorpayPaymentId: "pay_x" } }), NOW)
    ).toMatchObject({
      eligible: false,
      reason: "payment_id",
    });
  });
  it("refuses a bill number on a CREATED order", () => {
    expect(
      r1Decision(session({ order: { billNumber: "UK/1" } }), NOW).reason
    ).toBe("bill_number");
  });
  it("refuses a REDEEMED coupon, but not a RELEASED or PENDING one", () => {
    expect(
      r1Decision(
        session({ order: { couponRedemption: { status: "REDEEMED" } } }),
        NOW
      ).reason
    ).toBe("coupon_redeemed");
    for (const status of ["RELEASED", "PENDING", "RESERVED"]) {
      expect(
        r1Decision(session({ order: { couponRedemption: { status } } }), NOW)
          .eligible
      ).toBe(true);
    }
  });
  it("an empty payment id string does not block (falsy), a non-empty one does", () => {
    expect(
      r1Decision(session({ order: { razorpayPaymentId: "" } }), NOW).eligible
    ).toBe(true);
  });
});

describe("r1Decision: page versions", () => {
  const WALK: Record<string, boolean> = {
    QUEUED: true,
    TEXT_STAMPING: true,
    TEXT_STAMPED: true,
    GENERATING_SD: true,
    SD_READY: false,
    FAILED: false,
  };
  it("covers every PageVersionStatus exactly", () => {
    expect(Object.keys(WALK).sort()).toEqual(
      Object.values(PageVersionStatus).sort()
    );
  });
  for (const [status, live] of Object.entries(WALK)) {
    it(`${status} is ${live ? "live" : "not live"}`, () => {
      expect(isLiveVersionStatus(status)).toBe(live);
      const d = r1Decision(session({ pageVersions: [{ status }] }), NOW);
      expect(d.eligible).toBe(!live);
      if (live) expect(d.reason).toBe("page_version_live");
    });
  }
  it("one live version among finished ones refuses", () => {
    const d = r1Decision(
      session({
        pageVersions: [
          { status: "SD_READY" },
          { status: "FAILED" },
          { status: "TEXT_STAMPED" },
        ],
      }),
      NOW
    );
    expect(d.reason).toBe("page_version_live");
  });
  it("only SD_READY and FAILED versions are fine", () => {
    expect(
      r1Decision(
        session({
          pageVersions: [{ status: "SD_READY" }, { status: "FAILED" }],
        }),
        NOW
      ).eligible
    ).toBe(true);
  });
  it("the clock is checked before page versions", () => {
    expect(
      r1Decision(
        session({ expiresAt: at(D), pageVersions: [{ status: "QUEUED" }] }),
        NOW
      ).reason
    ).toBe("not_due");
  });
});

describe("r1Decision: no order, every session status", () => {
  const EXEMPT: Record<OrderSessionStatus, boolean> = {
    CREATED: false,
    PHOTO_UPLOADED: false,
    GENERATING_PREVIEW: false,
    PREVIEW_READY: false,
    AWAITING_PAYMENT: true,
    PAID: true,
    GENERATING_PAID: true,
    PAID_PAGES_READY: true,
    CONFIRMED: true,
    COMPILING_PDF: true,
    PDF_FAILED: true,
    SHIPMENT_QUEUED: true,
    SHIPMENT_FAILED: true,
    COMPLETED: true,
    FAILED: false,
  };
  it("covers every OrderSessionStatus exactly", () => {
    expect(Object.keys(EXEMPT).sort()).toEqual(
      Object.values(OrderSessionStatus).sort()
    );
  });
  for (const [status, exempt] of Object.entries(EXEMPT)) {
    it(`${status} without an order is ${exempt ? "refused" : "eligible with no payment check"}`, () => {
      const d = r1Decision(
        session({ status: status as OrderSessionStatus, order: null }),
        NOW
      );
      if (exempt) {
        expect(d).toEqual({
          eligible: false,
          reason: "status_exempt_without_order",
          needsPaymentCheck: false,
          pastCap: false,
        });
      } else {
        expect(d).toEqual({
          eligible: true,
          reason: "no_order",
          needsPaymentCheck: false,
          pastCap: false,
        });
      }
    });
  }
});

describe("r1Decision: every order status", () => {
  const ORDER: Record<OrderStatus, "proceeds" | "refused"> = {
    CREATED: "proceeds",
    PAID: "refused",
    GENERATED: "refused",
    CONFIRMED: "refused",
    SHIPROCKET_FAILED: "refused",
    READY_TO_SHIP: "refused",
    SHIPPED: "refused",
    DELIVERED: "refused",
    CANCELLED: "refused",
  };
  it("covers every OrderStatus exactly", () => {
    expect(Object.keys(ORDER).sort()).toEqual(
      Object.values(OrderStatus).sort()
    );
  });
  for (const [status, outcome] of Object.entries(ORDER)) {
    it(`${status} ${outcome}`, () => {
      const d = r1Decision(session({ order: { status } }), NOW);
      if (outcome === "proceeds") {
        expect(d).toMatchObject({
          eligible: true,
          reason: "created_order",
          needsPaymentCheck: true,
        });
      } else {
        expect(d).toEqual({
          eligible: false,
          reason: `order_${status}`,
          needsPaymentCheck: false,
          pastCap: false,
        });
      }
    });
  }
  it("refuses a paid-looking order whatever the session status says", () => {
    for (const status of Object.values(OrderSessionStatus)) {
      expect(
        r1Decision(session({ status, order: { status: "PAID" } }), NOW).eligible
      ).toBe(false);
    }
  });
});

describe("r1Decision: session statuses with a CREATED order", () => {
  const ALLOWED: Record<OrderSessionStatus, boolean> = {
    CREATED: false,
    PHOTO_UPLOADED: false,
    GENERATING_PREVIEW: true,
    PREVIEW_READY: true,
    AWAITING_PAYMENT: true,
    PAID: false,
    GENERATING_PAID: false,
    PAID_PAGES_READY: false,
    CONFIRMED: false,
    COMPILING_PDF: false,
    PDF_FAILED: false,
    SHIPMENT_QUEUED: false,
    SHIPMENT_FAILED: false,
    COMPLETED: false,
    FAILED: true,
  };
  it("covers every OrderSessionStatus exactly", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual(
      Object.values(OrderSessionStatus).sort()
    );
  });
  for (const [status, allowed] of Object.entries(ALLOWED)) {
    it(`${status} is ${allowed ? "allowed" : "refused"}`, () => {
      const d = r1Decision(
        session({ status: status as OrderSessionStatus, order: {} }),
        NOW
      );
      expect(d.eligible).toBe(allowed);
      expect(d.reason).toBe(
        allowed ? "created_order" : `session_status_${status}`
      );
    });
  }
});

describe("deliveredDecision", () => {
  const CREATED_AT = at(-60 * D);
  const order = (deliveredAt: Date | null, status = "DELIVERED") => ({
    status,
    createdAt: CREATED_AT,
    deliveredAt,
  });

  for (const days of [3, 45]) {
    describe(`${days} days`, () => {
      // deliveredAt such that the due moment (deliveredAt + days + 1 hour) is `offset` from now.
      const dueAtOffset = (offset: number) => at(offset - days * D - H);
      it("is not due one second before delivered + days + 1 hour", () => {
        expect(deliveredDecision(order(dueAtOffset(S)), NOW, days)).toBe(
          "not_due"
        );
      });
      it("is due exactly at delivered + days + 1 hour", () => {
        expect(deliveredDecision(order(dueAtOffset(0)), NOW, days)).toBe("due");
      });
      it("is due one second after", () => {
        expect(deliveredDecision(order(dueAtOffset(-S)), NOW, days)).toBe(
          "due"
        );
      });
      it("is not due when delivered exactly `days` ago (the 1 hour margin still holds)", () => {
        expect(deliveredDecision(order(at(-days * D)), NOW, days)).toBe(
          "not_due"
        );
      });
    });
  }

  it("the 3-day and 45-day clocks differ", () => {
    const delivered = at(-4 * D);
    expect(deliveredDecision(order(delivered), NOW, 3)).toBe("due");
    expect(deliveredDecision(order(delivered), NOW, 45)).toBe("not_due");
  });

  const STATUSES: Record<OrderStatus, "checked" | "not_due"> = {
    CREATED: "not_due",
    PAID: "not_due",
    GENERATED: "not_due",
    CONFIRMED: "not_due",
    SHIPROCKET_FAILED: "not_due",
    READY_TO_SHIP: "not_due",
    SHIPPED: "not_due",
    DELIVERED: "checked",
    CANCELLED: "not_due",
  };
  it("covers every OrderStatus exactly", () => {
    expect(Object.keys(STATUSES).sort()).toEqual(
      Object.values(OrderStatus).sort()
    );
  });
  for (const [status, outcome] of Object.entries(STATUSES)) {
    it(`${status}: ${outcome === "checked" ? "judged by the clock" : "never due, even with a long-past date"}`, () => {
      const result = deliveredDecision(order(at(-50 * D), status), NOW, 3);
      expect(result).toBe(outcome === "checked" ? "due" : "not_due");
    });
    it(`${status}: a null date is ${outcome === "checked" ? "a failed clock" : "not_due"}`, () => {
      const result = deliveredDecision(order(null, status), NOW, 3);
      expect(result).toBe(outcome === "checked" ? "failed_clock" : "not_due");
    });
  }

  it("a delivered date before createdAt is a failed clock; equal to createdAt is not", () => {
    expect(
      deliveredDecision(order(new Date(CREATED_AT.getTime() - S)), NOW, 3)
    ).toBe("failed_clock");
    expect(deliveredDecision(order(CREATED_AT), NOW, 3)).toBe("due");
  });

  it("a delivered date ahead of now: 5.5 h and exactly 6 h are tolerated, 7 h is a failed clock", () => {
    expect(deliveredDecision(order(at(5.5 * H)), NOW, 3)).toBe("not_due");
    expect(deliveredDecision(order(at(6 * H)), NOW, 3)).toBe("not_due");
    expect(deliveredDecision(order(at(6 * H + S)), NOW, 3)).toBe(
      "failed_clock"
    );
    expect(deliveredDecision(order(at(7 * H)), NOW, 3)).toBe("failed_clock");
  });

  it("a future date is never due, however small the period", () => {
    expect(deliveredDecision(order(at(H)), NOW, 0)).toBe("not_due");
  });
});
