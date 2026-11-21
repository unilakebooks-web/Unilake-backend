// Integration tests for confirming a payment from the customer's own page (BUG-029): the server asks
// Razorpay (mocked here) and marks the order paid when a matching captured payment exists. They run
// against the Neon TEST branch only: the setup import below refuses any other database.
import "../setup/env.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { razorpay } from "../../src/lib/razorpay.js";
import { config } from "../../src/config/env.js";
import { logger } from "../../src/lib/logger.js";
import { handleRazorpayWebhook } from "../../src/services/webhook.service.js";
import {
  confirmPaymentWithRazorpay,
  withRazorpayTimeout,
} from "../../src/services/paymentConfirmation.service.js";
import { AppError } from "../../src/utils/errors.js";

const MARK = "__vitest_payconf__";
const RUN = Math.random().toString(36).slice(2, 8);
const COMIC_ID = "00000000-0000-4000-8000-000000000100";
const userIds: string[] = [];
let n = 0;

async function makeUser() {
  const id = `${MARK}-${RUN}-${userIds.length}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  userIds.push(id);
  return id;
}

/** An unpaid session and order, the way checkout leaves them, with its own Razorpay order id. */
async function makeOrder(
  extra: {
    superseded?: string[];
    sessionStatus?: "AWAITING_PAYMENT" | "PAID";
    orderStatus?: "CREATED" | "PAID";
    /** A PAID order is made to look paid five minutes ago, unless this is true (just now). */
    justPaid?: boolean;
    amount?: number;
    currency?: string;
    countryCode?: string;
  } = {}
) {
  const userId = await makeUser();
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId,
      status: extra.sessionStatus ?? "AWAITING_PAYMENT",
      coverType: "HARDCOVER",
      shippingName: "Test",
      shippingLine1: "1 Test St",
      shippingCity: "Mumbai",
      shippingState: "Maharashtra",
      shippingZip: "400001",
      shippingCountry: "IN",
      shippingPhone: "9999999999",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const rzp = `order_${MARK}_${RUN}_${++n}`;
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: extra.amount ?? 999,
      currency: extra.currency ?? "INR",
      countryCode: extra.countryCode ?? "IN",
      coverType: "HARDCOVER",
      razorpayOrderId: rzp,
      ...(extra.orderStatus === "PAID" && !extra.justPaid
        ? { updatedAt: new Date(Date.now() - 5 * 60_000) }
        : {}),
      status: extra.orderStatus ?? "CREATED",
      razorpayPaymentId:
        extra.orderStatus === "PAID" ? `pay_${MARK}_${n}` : null,
      supersededRazorpayOrderIds: extra.superseded ?? [],
    },
  });
  return { sessionId: session.id, orderId: order.id, rzp };
}

const payment = (rzp: string, over: Record<string, unknown> = {}) => ({
  id: `pay_${MARK}_${RUN}_${++n}`,
  order_id: rzp,
  status: "captured",
  amount: 99900,
  currency: "INR",
  amount_refunded: 0,
  ...over,
});

const razorpayReturns = (items: unknown[]) =>
  vi.spyOn(razorpay.orders, "fetchPayments").mockResolvedValue({
    entity: "collection",
    count: items.length,
    items,
  } as never);

const state = async (orderId: string, sessionId: string) => ({
  order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
  session: await prisma.orderSession.findUniqueOrThrow({
    where: { id: sessionId },
  }),
});

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `${MARK}-` } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  const sessions = await prisma.orderSession.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);
  await prisma.webhookEvent.deleteMany({
    where: {
      OR: [
        { eventId: { startsWith: `evt_${MARK}` } },
        { order: { orderSessionId: { in: sessionIds } } },
      ],
    },
  });
  await prisma.order.deleteMany({
    where: { orderSessionId: { in: sessionIds } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});
afterEach(() => vi.restoreAllMocks());

describe("confirming a payment from the customer's page", () => {
  it("marks the order and session paid for a matching captured payment, once", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    const spy = razorpayReturns([payment(rzp)]);

    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result.confirmed).toBe(true);

    const { order, session } = await state(orderId, sessionId);
    expect(order.status).toBe("PAID");
    expect(order.razorpayPaymentId).toMatch(/^pay_/);
    expect(order.billNumber).not.toBeNull();
    expect(session.status).toBe("GENERATING_PAID");
    expect(spy).toHaveBeenCalledTimes(1);

    // Asked again: nothing changes, Razorpay is not called, the bill number stays.
    const again = await confirmPaymentWithRazorpay(sessionId);
    expect(again.confirmed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await state(orderId, sessionId)).order.billNumber).toBe(
      order.billNumber
    );
  });

  it("ignores a failed attempt in the list and applies the captured one", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    razorpayReturns([payment(rzp, { status: "failed" }), payment(rzp)]);
    expect((await confirmPaymentWithRazorpay(sessionId)).confirmed).toBe(true);
    expect((await state(orderId, sessionId)).order.status).toBe("PAID");
  });

  it.each([
    ["authorized only", { status: "authorized" }],
    ["wrong amount", { amount: 100 }],
    ["wrong currency", { currency: "USD" }],
    ["another Razorpay order", { order_id: "order_someone_else" }],
    ["refunded", { amount_refunded: 99900 }],
  ])(
    "does not mark the order paid for a payment that is %s",
    async (_label, over) => {
      const { sessionId, orderId, rzp } = await makeOrder();
      razorpayReturns([payment(rzp, over)]);
      const result = await confirmPaymentWithRazorpay(sessionId);
      expect(result.confirmed).toBe(false);
      const { order, session } = await state(orderId, sessionId);
      expect(order.status).toBe("CREATED");
      expect(session.status).toBe("AWAITING_PAYMENT");
    }
  );

  it("answers 'not confirmed' without throwing when Razorpay fails", async () => {
    const { sessionId, orderId } = await makeOrder();
    vi.spyOn(razorpay.orders, "fetchPayments").mockRejectedValue(
      new Error("gateway down")
    );
    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result).toEqual({ status: "AWAITING_PAYMENT", confirmed: false });
    expect((await state(orderId, sessionId)).order.status).toBe("CREATED");
  });

  it("does not ask Razorpay twice inside the minimum interval", async () => {
    const { sessionId, rzp } = await makeOrder();
    const spy = razorpayReturns([payment(rzp, { status: "authorized" })]);
    await confirmPaymentWithRazorpay(sessionId);
    const second = await confirmPaymentWithRazorpay(sessionId);
    expect(second.confirmed).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports but never applies a payment on a superseded Razorpay order", async () => {
    const { sessionId, orderId } = await makeOrder({
      superseded: [`order_old_${MARK}_${RUN}`],
    });
    const spy = vi.spyOn(razorpay.orders, "fetchPayments").mockImplementation(((
      id: string
    ) =>
      Promise.resolve({
        entity: "collection",
        count: id.startsWith("order_old_") ? 1 : 0,
        items: id.startsWith("order_old_") ? [payment(id)] : [],
      })) as never);
    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result.confirmed).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2); // the current order, then the replaced one
    expect((await state(orderId, sessionId)).order.status).toBe("CREATED");
  });

  it("runs the paid steps again for an order that is PAID while its session is still PAID", async () => {
    const { sessionId, orderId } = await makeOrder({
      orderStatus: "PAID",
      sessionStatus: "PAID",
    });
    const spy = razorpayReturns([]);
    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result.confirmed).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // the payment is already on the order
    expect((await state(orderId, sessionId)).session.status).toBe(
      "GENERATING_PAID"
    );
  });

  it("does not call a cancelled order confirmed", async () => {
    const { sessionId, orderId } = await makeOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED" },
    });
    const spy = razorpayReturns([]);
    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result.confirmed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs a captured payment that does not match the order, once, and never applies it", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    razorpayReturns([payment(rzp, { amount: 100 })]);
    const log = vi.spyOn(logger, "error");
    await confirmPaymentWithRazorpay(sessionId);
    const mismatches = () =>
      log.mock.calls.filter((c) =>
        String(c[1]).includes("does not match the Order")
      );
    expect(mismatches()).toHaveLength(1);
    expect((await state(orderId, sessionId)).order.status).toBe("CREATED");
  });

  it("asks Razorpay again once the minimum interval has passed", async () => {
    const { sessionId, rzp } = await makeOrder();
    const spy = razorpayReturns([payment(rzp, { status: "authorized" })]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await confirmPaymentWithRazorpay(sessionId);
      vi.setSystemTime(Date.now() + 4_000);
      await confirmPaymentWithRazorpay(sessionId);
    } finally {
      vi.useRealTimers();
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("runs the paid steps again for a PAID order whose session is still AWAITING_PAYMENT", async () => {
    const { sessionId, orderId } = await makeOrder({
      orderStatus: "PAID",
      sessionStatus: "AWAITING_PAYMENT",
    });
    razorpayReturns([]);
    expect((await confirmPaymentWithRazorpay(sessionId)).confirmed).toBe(true);
    expect((await state(orderId, sessionId)).session.status).toBe(
      "GENERATING_PAID"
    );
  });

  it("does not throw for a PAID order that has no payment id on record", async () => {
    const { sessionId, orderId } = await makeOrder({
      orderStatus: "PAID",
      sessionStatus: "PAID",
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { razorpayPaymentId: null },
    });
    const result = await confirmPaymentWithRazorpay(sessionId);
    expect(result.confirmed).toBe(true);
    expect((await state(orderId, sessionId)).session.status).toBe("PAID"); // left for the webhook or an admin
  });

  it("confirms a USD order and an order with a fractional amount in the smallest unit", async () => {
    const usd = await makeOrder({
      amount: 10.05,
      currency: "USD",
      countryCode: "US",
    });
    razorpayReturns([payment(usd.rzp, { amount: 1005, currency: "USD" })]);
    expect((await confirmPaymentWithRazorpay(usd.sessionId)).confirmed).toBe(
      true
    );
    expect((await state(usd.orderId, usd.sessionId)).order.status).toBe("PAID");
    const wrong = await makeOrder({
      amount: 10.05,
      currency: "USD",
      countryCode: "US",
    });
    razorpayReturns([payment(wrong.rzp, { amount: 1050, currency: "USD" })]);
    expect((await confirmPaymentWithRazorpay(wrong.sessionId)).confirmed).toBe(
      false
    );
  });

  it("leaves a just-paid order alone (its pages are probably being queued) and re-runs one stuck for a while", async () => {
    const fresh = await makeOrder({
      orderStatus: "PAID",
      sessionStatus: "PAID",
      justPaid: true,
    });
    const spy = razorpayReturns([]);
    const result = await confirmPaymentWithRazorpay(fresh.sessionId);
    expect(result.confirmed).toBe(true);
    expect((await state(fresh.orderId, fresh.sessionId)).session.status).toBe(
      "PAID"
    ); // not touched yet
    expect(spy).not.toHaveBeenCalled();
    const stuck = await makeOrder({
      orderStatus: "PAID",
      sessionStatus: "PAID",
    });
    await confirmPaymentWithRazorpay(stuck.sessionId);
    expect((await state(stuck.orderId, stuck.sessionId)).session.status).toBe(
      "GENERATING_PAID"
    );
  });

  it("leaves the paid pages to the other caller when the page rows collide, without an error or a flip", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    const pages = await prisma.page.findMany({
      where: { comicId: COMIC_ID },
      take: 2,
      orderBy: { pageNumber: "asc" },
    });
    await prisma.sessionPage.createMany({
      data: pages.map((p) => ({
        orderSessionId: sessionId,
        pageId: p.id,
        isPreviewPage: false,
      })),
    });
    razorpayReturns([payment(rzp)]);
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    // The row creation of the paid pages (an array transaction) fails once, the way it does when the
    // webhook and this confirmation create the same rows at the same moment.
    const client = prisma as unknown as {
      $transaction: (...a: unknown[]) => unknown;
    };
    const real = client.$transaction;
    client.$transaction = function (this: unknown, ...args: unknown[]) {
      if (Array.isArray(args[0])) {
        client.$transaction = real;
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("collision", {
            code: "P2002",
            clientVersion: "test",
          })
        );
      }
      return real.apply(client, args);
    };
    try {
      const result = await confirmPaymentWithRazorpay(sessionId);
      expect(result.confirmed).toBe(true); // the order is paid
    } finally {
      client.$transaction = real;
    }
    const { order, session } = await state(orderId, sessionId);
    expect(order.status).toBe("PAID");
    expect(session.status).toBe("PAID"); // the other caller flips it once its pages are queued
    // It is a hand-off, not a failure: a warning, and no "confirmation failed" error.
    expect(warn.mock.calls.some((c) => String(c[1]).includes("collided"))).toBe(
      true
    );
    expect(
      error.mock.calls.some((c) =>
        String(c[1]).includes("Payment confirmation failed")
      )
    ).toBe(false);
  });

  it("when the webhook is the one that collides, it drops its record and reports an error so Razorpay retries", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    const pages = await prisma.page.findMany({
      where: { comicId: COMIC_ID },
      take: 2,
      orderBy: { pageNumber: "asc" },
    });
    await prisma.sessionPage.createMany({
      data: pages.map((p) => ({
        orderSessionId: sessionId,
        pageId: p.id,
        isPreviewPage: false,
      })),
    });
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: payment(rzp) } },
    });
    const signature = createHmac(
      "sha256",
      config.razorpay.razorpayWebhookSecret
    )
      .update(body)
      .digest("hex");
    const eventId = `evt_${MARK}_collide_${RUN}`;
    const client = prisma as unknown as {
      $transaction: (...a: unknown[]) => unknown;
    };
    const real = client.$transaction;
    client.$transaction = function (this: unknown, ...args: unknown[]) {
      if (Array.isArray(args[0])) {
        client.$transaction = real;
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError("collision", {
            code: "P2002",
            clientVersion: "test",
          })
        );
      }
      return real.apply(client, args);
    };
    try {
      await expect(
        handleRazorpayWebhook(Buffer.from(body), signature, eventId)
      ).rejects.toBeDefined();
    } finally {
      client.$transaction = real;
    }
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0); // so the redelivery is processed
    const { order } = await state(orderId, sessionId);
    expect(order.status).toBe("PAID");
  });

  it("refuses an unknown session and an admin sample", async () => {
    await expect(confirmPaymentWithRazorpay(randomUUID())).rejects.toThrow(
      AppError
    );
    const userId = await makeUser();
    const sample = await prisma.orderSession.create({
      data: {
        comicId: COMIC_ID,
        userId,
        isSample: true,
        status: "PREVIEW_READY",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await expect(confirmPaymentWithRazorpay(sample.id)).rejects.toThrow(
      /admin sample/
    );
  });

  it("a session without an order has nothing to confirm", async () => {
    const userId = await makeUser();
    const s = await prisma.orderSession.create({
      data: {
        comicId: COMIC_ID,
        userId,
        status: "PREVIEW_READY",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const spy = razorpayReturns([]);
    expect(await confirmPaymentWithRazorpay(s.id)).toEqual({
      status: "PREVIEW_READY",
      confirmed: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("the webhook and the confirmation racing give one flip, one bill number, one finished state", async () => {
    const { sessionId, orderId, rzp } = await makeOrder();
    razorpayReturns([payment(rzp)]);
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: payment(rzp) } },
    });
    const signature = createHmac(
      "sha256",
      config.razorpay.razorpayWebhookSecret
    )
      .update(body)
      .digest("hex");

    await Promise.all([
      handleRazorpayWebhook(
        Buffer.from(body),
        signature,
        `evt_${MARK}_race_${RUN}`
      ),
      confirmPaymentWithRazorpay(sessionId),
    ]);

    const { order, session } = await state(orderId, sessionId);
    expect(order.status).toBe("PAID");
    expect(session.status).toBe("GENERATING_PAID");
    const billNumber = order.billNumber;
    expect(billNumber).not.toBeNull();

    // The webhook delivered again afterwards changes nothing.
    await handleRazorpayWebhook(
      Buffer.from(body),
      signature,
      `evt_${MARK}_race2_${RUN}`
    );
    expect((await state(orderId, sessionId)).order.billNumber).toBe(billNumber);
  });
});

describe("limits on the Razorpay lookup", () => {
  it("gives up on a Razorpay call that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = withRazorpayTimeout(
        new Promise<never>(() => undefined),
        50
      );
      const outcome = expect(pending).rejects.toThrow(/did not answer in time/);
      await vi.advanceTimersByTimeAsync(60);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run more than 5 Razorpay lookups at once; the 6th call answers 'not confirmed'", async () => {
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push(await makeOrder());
    const releases: Array<() => void> = [];
    const spy = vi.spyOn(razorpay.orders, "fetchPayments").mockImplementation(
      (() =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve({ entity: "collection", count: 0, items: [] })
          );
        })) as never
    );

    const running = orders
      .slice(0, 5)
      .map((o) => confirmPaymentWithRazorpay(o.sessionId));
    const deadline = Date.now() + 10_000;
    while (spy.mock.calls.length < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(spy).toHaveBeenCalledTimes(5);

    const sixth = await confirmPaymentWithRazorpay(orders[5]!.sessionId);
    expect(sixth.confirmed).toBe(false);
    expect(spy).toHaveBeenCalledTimes(5); // the sixth never reached Razorpay

    releases.forEach((release) => release());
    await Promise.all(running);
  });
});
