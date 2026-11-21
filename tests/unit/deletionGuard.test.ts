import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/razorpay.js", () => ({ razorpay: { orders: {} } }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  evaluatePayments,
  checkRazorpay,
  PAYMENT_EVENT_TYPES,
  type RazorpayReader,
} from "../../src/services/dataDeletionGuard.service.js";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
const NOW = new Date("2026-11-21T12:00:00.000Z");
/** A Razorpay payment created `ageMs` ago (created_at is in seconds). */
const pay = (status: unknown, ageMs: number) => ({
  status,
  created_at: Math.floor((NOW.getTime() - ageMs) / 1000),
});

describe("PAYMENT_EVENT_TYPES", () => {
  it("is exactly the three kinds that prove a payment, and never a failed attempt", () => {
    expect([...PAYMENT_EVENT_TYPES].sort()).toEqual(
      ["order.paid", "payment.authorized", "payment.captured"].sort()
    );
    expect(PAYMENT_EVENT_TYPES).not.toContain("payment.failed");
  });
});

describe("evaluatePayments", () => {
  it("no payments is clear", () => {
    expect(evaluatePayments([], NOW, false)).toEqual({ kind: "clear" });
    expect(evaluatePayments([], NOW, true)).toEqual({ kind: "clear" });
  });

  describe("failed", () => {
    it("1 hour ago blocks before the cap", () => {
      expect(evaluatePayments([pay("failed", H)], NOW, false)).toEqual({
        kind: "blocked",
        reason: "payment_failed_recent",
      });
    });
    it("1 hour ago is clear past the cap", () => {
      expect(evaluatePayments([pay("failed", H)], NOW, true)).toEqual({
        kind: "clear",
      });
    });
    it("3 days ago is clear either way", () => {
      expect(evaluatePayments([pay("failed", 3 * D)], NOW, false)).toEqual({
        kind: "clear",
      });
      expect(evaluatePayments([pay("failed", 3 * D)], NOW, true)).toEqual({
        kind: "clear",
      });
    });
    it("one second under 2 days blocks, exactly 2 days is clear", () => {
      expect(
        evaluatePayments([pay("failed", 2 * D - S)], NOW, false).kind
      ).toBe("blocked");
      expect(evaluatePayments([pay("failed", 2 * D)], NOW, false)).toEqual({
        kind: "clear",
      });
    });
    it("with no usable created_at blocks, even past the cap", () => {
      for (const created_at of [undefined, null, "1700000000", NaN]) {
        expect(
          evaluatePayments([{ status: "failed", created_at }], NOW, true)
        ).toEqual({
          kind: "blocked",
          reason: "payment_failed_unknown_age",
        });
      }
    });
  });

  describe("created", () => {
    it("10 minutes ago is in flight, even past the cap", () => {
      expect(evaluatePayments([pay("created", 10 * MIN)], NOW, false)).toEqual({
        kind: "blocked",
        reason: "payment_in_flight",
      });
      expect(evaluatePayments([pay("created", 10 * MIN)], NOW, true)).toEqual({
        kind: "blocked",
        reason: "payment_in_flight",
      });
    });
    it("one second under 1 hour is still in flight, exactly 1 hour is not", () => {
      expect(
        evaluatePayments([pay("created", H - S)], NOW, true)
      ).toMatchObject({
        reason: "payment_in_flight",
      });
      expect(evaluatePayments([pay("created", H)], NOW, true)).toEqual({
        kind: "needs_order_status",
      });
    });
    it("1 hour ago holds the order before the cap (payment_created_recent)", () => {
      expect(evaluatePayments([pay("created", H)], NOW, false)).toEqual({
        kind: "blocked",
        reason: "payment_created_recent",
      });
    });
    it("1 hour ago past the cap needs the order's own status", () => {
      expect(evaluatePayments([pay("created", H)], NOW, true)).toEqual({
        kind: "needs_order_status",
      });
    });
    it("3 days ago needs the order's status, past the cap or not", () => {
      expect(evaluatePayments([pay("created", 3 * D)], NOW, false)).toEqual({
        kind: "needs_order_status",
      });
      expect(evaluatePayments([pay("created", 3 * D)], NOW, true)).toEqual({
        kind: "needs_order_status",
      });
    });
    it("2 days minus one second blocks before the cap, exactly 2 days needs the status", () => {
      expect(
        evaluatePayments([pay("created", 2 * D - S)], NOW, false).kind
      ).toBe("blocked");
      expect(evaluatePayments([pay("created", 2 * D)], NOW, false).kind).toBe(
        "needs_order_status"
      );
    });
    it("with no usable created_at blocks", () => {
      expect(evaluatePayments([{ status: "created" }], NOW, true)).toEqual({
        kind: "blocked",
        reason: "payment_created_unknown_age",
      });
    });
    it("a created_at in the future counts as in flight", () => {
      expect(evaluatePayments([pay("created", -H)], NOW, true)).toMatchObject({
        reason: "payment_in_flight",
      });
    });
  });

  describe("any other status blocks, whatever the age and the cap", () => {
    for (const status of [
      "captured",
      "authorized",
      "refunded",
      "chargeback",
      "weird",
    ]) {
      for (const [label, age] of [
        ["1 minute", MIN],
        ["30 days", 30 * D],
      ] as const) {
        for (const pastCap of [false, true]) {
          it(`${status}, ${label} old, pastCap=${pastCap}`, () => {
            expect(evaluatePayments([pay(status, age)], NOW, pastCap)).toEqual({
              kind: "blocked",
              reason: `payment_${status}`,
            });
          });
        }
      }
    }
    it("a missing or non-string status is unknown", () => {
      expect(evaluatePayments([{ created_at: 1 }], NOW, true)).toEqual({
        kind: "blocked",
        reason: "payment_unknown",
      });
      expect(evaluatePayments([pay(42, D)], NOW, true)).toEqual({
        kind: "blocked",
        reason: "payment_unknown",
      });
    });
  });

  it("an old failed payment plus a captured one blocks", () => {
    expect(
      evaluatePayments(
        [pay("failed", 10 * D), pay("captured", 10 * D)],
        NOW,
        true
      )
    ).toEqual({
      kind: "blocked",
      reason: "payment_captured",
    });
  });
  it("an old created payment plus a captured one blocks (not needs_order_status)", () => {
    expect(
      evaluatePayments(
        [pay("created", 10 * D), pay("captured", 10 * D)],
        NOW,
        true
      ).kind
    ).toBe("blocked");
  });
  it("old failed plus old created needs the order status", () => {
    expect(
      evaluatePayments(
        [pay("failed", 10 * D), pay("created", 10 * D)],
        NOW,
        true
      )
    ).toEqual({
      kind: "needs_order_status",
    });
  });
  it("only old failed payments are clear", () => {
    expect(
      evaluatePayments([pay("failed", 5 * D), pay("failed", 9 * D)], NOW, false)
    ).toEqual({
      kind: "clear",
    });
  });
});

describe("checkRazorpay", () => {
  const collection = (
    items: unknown[],
    over: Record<string, unknown> = {}
  ) => ({
    entity: "collection",
    count: items.length,
    items,
    ...over,
  });
  const reader = (
    payments: (id: string) => Promise<unknown> | unknown,
    order: (id: string) => Promise<unknown> | unknown = () => ({
      status: "created",
    })
  ) => {
    const fetchPayments = vi.fn(async (id: string) => payments(id));
    const fetchOrder = vi.fn(async (id: string) => order(id));
    return { fetchPayments, fetchOrder } satisfies RazorpayReader;
  };
  const order = (
    ids: string[] = []
  ): {
    razorpayOrderId: string | null;
    supersededRazorpayOrderIds: string[];
  } => ({
    razorpayOrderId: "order_1",
    supersededRazorpayOrderIds: ids,
  });
  const run = (
    r: RazorpayReader,
    o = order(),
    over: { pastCap?: boolean; budget?: number } = {}
  ) => {
    const budget = { left: over.budget ?? 20 };
    return checkRazorpay(o, NOW, over.pastCap ?? false, budget, r).then(
      (verdict) => ({
        verdict,
        budget,
      })
    );
  };

  beforeEach(() => vi.useRealTimers());

  it("skips an order with no Razorpay order id and calls nothing", async () => {
    const r = reader(() => collection([]));
    const { verdict } = await run(r, {
      razorpayOrderId: null,
      supersededRazorpayOrderIds: [],
    });
    expect(verdict).toEqual({ kind: "skip", reason: "no_razorpay_order_id" });
    expect(r.fetchPayments).not.toHaveBeenCalled();
  });

  it("is clear for an empty collection and spends one call", async () => {
    const r = reader(() => collection([]));
    const { verdict, budget } = await run(r);
    expect(verdict).toEqual({ kind: "clear" });
    expect(budget.left).toBe(19);
    expect(r.fetchOrder).not.toHaveBeenCalled();
  });

  it("is clear when only an old failed payment exists", async () => {
    const { verdict } = await run(
      reader(() => collection([pay("failed", 5 * D)]))
    );
    expect(verdict).toEqual({ kind: "clear" });
  });

  it("blocks on a captured payment", async () => {
    const { verdict } = await run(
      reader(() => collection([pay("captured", 5 * D)]))
    );
    expect(verdict).toEqual({ kind: "blocked", reason: "payment_captured" });
  });

  describe("the needs-order-status path", () => {
    const oldCreated = () => collection([pay("created", 5 * D)]);
    it("blocks when Razorpay says the order is paid", async () => {
      const r = reader(oldCreated, () => ({ status: "paid" }));
      const { verdict, budget } = await run(r);
      expect(verdict).toEqual({
        kind: "blocked",
        reason: "razorpay_order_paid",
      });
      expect(r.fetchOrder).toHaveBeenCalledWith("order_1");
      expect(budget.left).toBe(18);
    });
    it("is clear when the order is still created", async () => {
      const { verdict } = await run(
        reader(oldCreated, () => ({ status: "created" }))
      );
      expect(verdict).toEqual({ kind: "clear" });
    });
    it("is clear when the order is attempted (only paid blocks)", async () => {
      const { verdict } = await run(
        reader(oldCreated, () => ({ status: "attempted" }))
      );
      expect(verdict).toEqual({ kind: "clear" });
    });
    it("skips on a malformed order answer", async () => {
      for (const answer of [{}, { status: 5 }, null, undefined, "paid"]) {
        const { verdict } = await run(reader(oldCreated, () => answer));
        expect(verdict).toEqual({ kind: "skip", reason: "malformed_answer" });
      }
    });
    it("skips when the order read throws, even with a 400", async () => {
      const { verdict } = await run(
        reader(oldCreated, () => {
          throw Object.assign(new Error("bad"), { statusCode: 400 });
        })
      );
      expect(verdict).toEqual({ kind: "skip", reason: "razorpay_error" });
    });
    it("skips with not_checked when the budget has no call left for the extra order fetch", async () => {
      const r = reader(oldCreated, () => ({ status: "paid" }));
      const { verdict, budget } = await run(r, order(), { budget: 1 });
      expect(verdict).toEqual({ kind: "skip", reason: "not_checked" });
      expect(r.fetchOrder).not.toHaveBeenCalled();
      expect(budget.left).toBe(0);
    });
    it("a recent created payment blocks before the cap without the order read, a clear one past the cap needs it", async () => {
      const recent = reader(() => collection([pay("created", 3 * H)]));
      expect((await run(recent)).verdict).toEqual({
        kind: "blocked",
        reason: "payment_created_recent",
      });
      expect(recent.fetchOrder).not.toHaveBeenCalled();
      const past = reader(
        () => collection([pay("created", 3 * H)]),
        () => ({ status: "paid" })
      );
      expect((await run(past, order(), { pastCap: true })).verdict).toEqual({
        kind: "blocked",
        reason: "razorpay_order_paid",
      });
    });
  });

  describe("malformed answers skip", () => {
    const cases: [string, unknown][] = [
      ["count too big", collection([pay("failed", 5 * D)], { count: 2 })],
      ["count too small", collection([pay("failed", 5 * D)], { count: 0 })],
      ["count missing", { entity: "collection", items: [] }],
      ["count is a string", collection([], { count: "0" })],
      ["items missing", { entity: "collection", count: 0 }],
      ["items not an array", { entity: "collection", count: 0, items: {} }],
      ["wrong entity", collection([], { entity: "order" })],
      ["entity missing", { count: 0, items: [] }],
      ["null", null],
      ["undefined", undefined],
      ["a string", "collection"],
      ["an array", []],
    ];
    for (const [label, answer] of cases) {
      it(label, async () => {
        const { verdict } = await run(reader(() => answer));
        expect(verdict).toEqual({ kind: "skip", reason: "malformed_answer" });
      });
    }
  });

  describe("errors", () => {
    const fail = (error: unknown) =>
      reader(() => {
        throw error;
      });
    it("a plain error skips", async () => {
      expect((await run(fail(new Error("boom")))).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
    });
    it("a thrown non-object skips", async () => {
      expect((await run(fail(undefined))).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
      expect((await run(fail(null))).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
      expect((await run(fail("x"))).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
    });
    it("statusCode 400 and 404 block as an unknown order", async () => {
      for (const statusCode of [400, 404]) {
        expect((await run(fail({ statusCode }))).verdict).toEqual({
          kind: "blocked",
          reason: "unknown_order",
        });
      }
    });
    it("other status codes skip", async () => {
      for (const statusCode of [401, 429, 500, 502]) {
        expect((await run(fail({ statusCode }))).verdict).toEqual({
          kind: "skip",
          reason: "razorpay_error",
        });
      }
    });
    it("a rejected promise is handled like a throw", async () => {
      const r: RazorpayReader = {
        fetchPayments: () => Promise.reject({ statusCode: 400 }),
        fetchOrder: () => Promise.resolve({}),
      };
      expect((await run(r)).verdict).toEqual({
        kind: "blocked",
        reason: "unknown_order",
      });
    });
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a payments read that never answers skips after 5 seconds", async () => {
      const r: RazorpayReader = {
        fetchPayments: () => new Promise(() => {}),
        fetchOrder: () => Promise.resolve({}),
      };
      const result = run(r);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await result).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
    });

    it("an order read that never answers skips after 5 seconds", async () => {
      const r: RazorpayReader = {
        fetchPayments: () =>
          Promise.resolve(collection([pay("created", 5 * D)])),
        fetchOrder: () => new Promise(() => {}),
      };
      const result = run(r);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await result).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
    });

    it("clears its timer when the read answers", async () => {
      await run(reader(() => collection([])));
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("the call budget", () => {
    it("budget 0 skips with not_checked and calls nothing", async () => {
      const r = reader(() => collection([]));
      const { verdict, budget } = await run(r, order(["order_0"]), {
        budget: 0,
      });
      expect(verdict).toEqual({ kind: "skip", reason: "not_checked" });
      expect(r.fetchPayments).not.toHaveBeenCalled();
      expect(budget.left).toBe(0);
    });
    it("a negative budget also skips", async () => {
      const r = reader(() => collection([]));
      expect((await run(r, order(), { budget: -3 })).verdict).toEqual({
        kind: "skip",
        reason: "not_checked",
      });
      expect(r.fetchPayments).not.toHaveBeenCalled();
    });
    it("every payments read consumes one call", async () => {
      const r = reader(() => collection([]));
      const { budget } = await run(r, order(["a", "b", "c"]), { budget: 10 });
      expect(r.fetchPayments).toHaveBeenCalledTimes(4);
      expect(budget.left).toBe(6);
    });
    it("a failed read still consumes its call", async () => {
      const r = reader(() => {
        throw new Error("x");
      });
      const { budget } = await run(r, order(), { budget: 5 });
      expect(budget.left).toBe(4);
    });
    it("the extra order fetch consumes one more", async () => {
      const r = reader(
        () => collection([pay("created", 5 * D)]),
        () => ({ status: "created" })
      );
      const { budget } = await run(r, order(["old"]), { budget: 10 });
      expect(r.fetchPayments).toHaveBeenCalledTimes(2);
      expect(r.fetchOrder).toHaveBeenCalledTimes(2);
      expect(budget.left).toBe(6);
    });
    it("runs out in the middle of the ids: skips, and the later ids are not read", async () => {
      const r = reader(() => collection([]));
      const { verdict, budget } = await run(r, order(["a", "b"]), {
        budget: 2,
      });
      expect(verdict).toEqual({ kind: "skip", reason: "not_checked" });
      expect(r.fetchPayments).toHaveBeenCalledTimes(2);
      expect(budget.left).toBe(0);
    });
    it("is shared between calls through the same budget object", async () => {
      const r = reader(() => collection([]));
      const budget = { left: 2 };
      await checkRazorpay(order(), NOW, false, budget, r);
      await checkRazorpay(order(), NOW, false, budget, r);
      const third = await checkRazorpay(order(), NOW, false, budget, r);
      expect(third).toEqual({ kind: "skip", reason: "not_checked" });
      expect(r.fetchPayments).toHaveBeenCalledTimes(2);
    });
  });

  describe("superseded Razorpay orders", () => {
    it("checks every id, current first, and stops at the first block", async () => {
      const r = reader((id) =>
        collection(id === "old_2" ? [pay("captured", 9 * D)] : [])
      );
      const { verdict } = await run(r, order(["old_1", "old_2", "old_3"]));
      expect(verdict).toEqual({ kind: "blocked", reason: "payment_captured" });
      expect(r.fetchPayments.mock.calls.map((c) => c[0])).toEqual([
        "order_1",
        "old_1",
        "old_2",
      ]);
    });
    it("a capture on the second id blocks even though the first is clear", async () => {
      const calls: string[] = [];
      const r = reader((id) => {
        calls.push(id);
        return collection(calls.length === 2 ? [pay("captured", D)] : []);
      });
      expect((await run(r, order(["old_1"]))).verdict).toEqual({
        kind: "blocked",
        reason: "payment_captured",
      });
    });
    it("all clear reads every id and is clear", async () => {
      const r = reader(() => collection([]));
      expect((await run(r, order(["a", "b"]))).verdict).toEqual({
        kind: "clear",
      });
      expect(r.fetchPayments).toHaveBeenCalledTimes(3);
    });
    it("an unknown superseded id blocks as unknown_order", async () => {
      const r = reader((id) => {
        if (id === "gone") throw { statusCode: 400 };
        return collection([]);
      });
      expect((await run(r, order(["gone"]))).verdict).toEqual({
        kind: "blocked",
        reason: "unknown_order",
      });
    });
    it("an error on a superseded id skips the whole order", async () => {
      const r = reader((id) => {
        if (id === "old") throw new Error("net");
        return collection([]);
      });
      expect((await run(r, order(["old"]))).verdict).toEqual({
        kind: "skip",
        reason: "razorpay_error",
      });
    });
    it("a paid superseded order (order read) blocks", async () => {
      const r = reader(
        (id) => collection(id === "old" ? [pay("created", 9 * D)] : []),
        (id) => ({ status: id === "old" ? "paid" : "created" })
      );
      expect((await run(r, order(["old"]))).verdict).toEqual({
        kind: "blocked",
        reason: "razorpay_order_paid",
      });
      expect(r.fetchOrder).toHaveBeenCalledWith("old");
    });
  });
});
