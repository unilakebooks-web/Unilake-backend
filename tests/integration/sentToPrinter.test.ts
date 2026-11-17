// Integration tests for "Sent to Printer": marking, undoing, the eligibility
// rule, the admin list filter and detail, and that customers never see it.
// They run against the Neon TEST branch only: the setup import below refuses
// any other database.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  getAdminOrderDetail,
  getTrackingForUser,
  getUserOrder,
  listAdminOrders,
  listUserOrders,
  setOrderSentToPrinter,
} from "../../src/services/order.service.js";
import { listAdminOrdersQuerySchema } from "../../src/validators/order.schema.js";
import { AppError } from "../../src/utils/errors.js";
import type { OrderStatus } from "../../src/generated/prisma/client.js";

const MARK = "__vitest_sentprint__";
const ADMIN = "vitest-admin";
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const NAME = `${MARK} ${RUN}`;
const COMIC_ID = "00000000-0000-4000-8000-000000000100";

const userIds: string[] = [];
async function makeUser(label: string) {
  const id = `${MARK}-${RUN}-${label}-${userIds.length}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  userIds.push(id);
  return id;
}

/** An order staged directly in the given status, with or without a PDF. */
async function makeOrder(
  userId: string,
  status: OrderStatus,
  withPdf: boolean,
  name = NAME
) {
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId,
      status: "AWAITING_PAYMENT",
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
  const order = await prisma.order.create({
    data: {
      orderSessionId: session.id,
      amount: 999,
      currency: "INR",
      countryCode: "IN",
      coverType: "HARDCOVER",
      status,
      shippingName: name,
      pdfUrl: withPdf ? `${MARK}/${RUN}/book.pdf` : null,
    },
  });
  return order.id;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  return null;
}

const readOrder = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: { sentToPrinterAt: true, updatedAt: true },
  });

const adminList = (name: string, extra: Record<string, unknown>) =>
  listAdminOrders(
    listAdminOrdersQuerySchema.parse({ search: name, pageSize: 100, ...extra })
  );

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
  await prisma.order.deleteMany({
    where: { orderSessionId: { in: sessionIds } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let customer: string;

beforeAll(async () => {
  await cleanup();
  customer = await makeUser("customer");
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("setOrderSentToPrinter, marking", () => {
  it("marks an eligible order and returns its id and date", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    const before = Date.now();
    const result = await setOrderSentToPrinter(id, true, ADMIN);
    expect(result.id).toBe(id);
    expect(result.sentToPrinterAt).toBeInstanceOf(Date);
    expect(Math.abs(result.sentToPrinterAt!.getTime() - before)).toBeLessThan(
      60_000
    );
    expect((await readOrder(id)).sentToPrinterAt).toEqual(
      result.sentToPrinterAt
    );
  });

  it("keeps the first date when marked again", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    const first = await setOrderSentToPrinter(id, true, ADMIN);
    await new Promise((r) => setTimeout(r, 30));
    const second = await setOrderSentToPrinter(id, true, ADMIN);
    expect(second.sentToPrinterAt).toEqual(first.sentToPrinterAt);
    expect((await readOrder(id)).sentToPrinterAt).toEqual(
      first.sentToPrinterAt
    );
  });

  it("gives parallel marks one date and no error", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => setOrderSentToPrinter(id, true, ADMIN))
    );
    const stored = (await readOrder(id)).sentToPrinterAt;
    expect(stored).not.toBeNull();
    for (const r of results) expect(r.sentToPrinterAt).toEqual(stored);
  });

  it("does not move updatedAt on mark or on undo", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    const before = (await readOrder(id)).updatedAt;
    await new Promise((r) => setTimeout(r, 30));
    await setOrderSentToPrinter(id, true, ADMIN);
    expect((await readOrder(id)).updatedAt).toEqual(before);
    await setOrderSentToPrinter(id, false, ADMIN);
    expect((await readOrder(id)).updatedAt).toEqual(before);
  });

  it("throws NotFound for an unknown order, on mark and on undo", async () => {
    const unknown = "00000000-0000-4000-8000-0000000000aa";
    const mark = await refusal(setOrderSentToPrinter(unknown, true, ADMIN));
    expect(mark?.statusCode).toBe(404);
    const undo = await refusal(setOrderSentToPrinter(unknown, false, ADMIN));
    expect(undo?.statusCode).toBe(404);
  });
});

describe("setOrderSentToPrinter, undo", () => {
  it("clears the date, and undoing twice or on an unmarked order succeeds", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    await setOrderSentToPrinter(id, true, ADMIN);
    const undone = await setOrderSentToPrinter(id, false, ADMIN);
    expect(undone).toEqual({ id, sentToPrinterAt: null });
    expect((await readOrder(id)).sentToPrinterAt).toBeNull();
    const again = await setOrderSentToPrinter(id, false, ADMIN);
    expect(again).toEqual({ id, sentToPrinterAt: null });

    const fresh = await makeOrder(customer, "CONFIRMED", true);
    const onFresh = await setOrderSentToPrinter(fresh, false, ADMIN);
    expect(onFresh).toEqual({ id: fresh, sentToPrinterAt: null });
  });

  it("lets a mark race an undo without an error", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    await setOrderSentToPrinter(id, true, ADMIN);
    const results = await Promise.allSettled([
      setOrderSentToPrinter(id, false, ADMIN),
      setOrderSentToPrinter(id, true, ADMIN),
      setOrderSentToPrinter(id, false, ADMIN),
      setOrderSentToPrinter(id, true, ADMIN),
    ]);
    for (const r of results) expect(r.status).toBe("fulfilled");
  });
});

describe("setOrderSentToPrinter, eligibility", () => {
  it("refuses an order without a PDF with a plain message", async () => {
    const id = await makeOrder(customer, "CONFIRMED", false);
    const error = await refusal(setOrderSentToPrinter(id, true, ADMIN));
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toBe("This order has no print-ready PDF yet");
    expect((await readOrder(id)).sentToPrinterAt).toBeNull();
  });

  it.each(["CREATED", "PAID", "GENERATED"] as OrderStatus[])(
    "refuses a %s order (no PDF yet)",
    async (status) => {
      const id = await makeOrder(customer, status, false);
      const error = await refusal(setOrderSentToPrinter(id, true, ADMIN));
      expect(error?.statusCode).toBe(409);
    }
  );

  it("refuses a cancelled order even with a PDF", async () => {
    const id = await makeOrder(customer, "CANCELLED", true);
    const error = await refusal(setOrderSentToPrinter(id, true, ADMIN));
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toBe("This order is cancelled");
  });

  it.each(["SHIPROCKET_FAILED", "SHIPPED", "DELIVERED"] as OrderStatus[])(
    "allows a %s order with a PDF",
    async (status) => {
      const id = await makeOrder(customer, status, true);
      const result = await setOrderSentToPrinter(id, true, ADMIN);
      expect(result.sentToPrinterAt).toBeInstanceOf(Date);
    }
  );
});

describe("admin list filter", () => {
  // Its own search term, so orders from the other tests do not interfere.
  const LIST_NAME = `${NAME} list`;

  it("filters sent and not_sent, with status, search and paging", async () => {
    const sentA = await makeOrder(customer, "CONFIRMED", true, LIST_NAME);
    const sentB = await makeOrder(customer, "SHIPPED", true, LIST_NAME);
    const open1 = await makeOrder(customer, "CONFIRMED", true, LIST_NAME);
    const open2 = await makeOrder(customer, "PAID", false, LIST_NAME);
    await setOrderSentToPrinter(sentA, true, ADMIN);
    await setOrderSentToPrinter(sentB, true, ADMIN);

    const all = await adminList(LIST_NAME, {});
    const allIds = all.orders.map((o) => o.id);
    for (const id of [sentA, sentB, open1, open2]) expect(allIds).toContain(id);
    const rowA = all.orders.find((o) => o.id === sentA)!;
    expect(rowA.sentToPrinterAt).toBeInstanceOf(Date);
    expect(all.orders.find((o) => o.id === open1)!.sentToPrinterAt).toBeNull();

    const sent = await adminList(LIST_NAME, { sentToPrinter: "sent" });
    expect(sent.orders.map((o) => o.id).sort()).toEqual([sentA, sentB].sort());
    expect(sent.pagination.total).toBe(2);

    const notSent = await adminList(LIST_NAME, { sentToPrinter: "not_sent" });
    expect(notSent.orders.map((o) => o.id).sort()).toEqual(
      [open1, open2].sort()
    );
    expect(notSent.pagination.total).toBe(2);

    const sentShipped = await adminList(LIST_NAME, {
      sentToPrinter: "sent",
      status: "SHIPPED",
    });
    expect(sentShipped.orders.map((o) => o.id)).toEqual([sentB]);

    const byId = await listAdminOrders(
      listAdminOrdersQuerySchema.parse({
        search: open1.slice(0, 13),
        sentToPrinter: "not_sent",
      })
    );
    expect(byId.orders.map((o) => o.id)).toEqual([open1]);
    const byIdSent = await listAdminOrders(
      listAdminOrdersQuerySchema.parse({
        search: open1.slice(0, 13),
        sentToPrinter: "sent",
      })
    );
    expect(byIdSent.orders).toHaveLength(0);

    const page1 = await adminList(LIST_NAME, {
      sentToPrinter: "sent",
      pageSize: 1,
    });
    const page2 = await adminList(LIST_NAME, {
      sentToPrinter: "sent",
      pageSize: 1,
      page: 2,
    });
    expect(page1.pagination.totalPages).toBe(2);
    expect(page1.orders).toHaveLength(1);
    expect(page2.orders).toHaveLength(1);
    expect(page1.orders[0]!.id).not.toBe(page2.orders[0]!.id);
  });
});

describe("admin detail", () => {
  it("returns sentToPrinterAt and canMarkSentToPrinter", async () => {
    const ok = await makeOrder(customer, "CONFIRMED", true);
    const noPdf = await makeOrder(customer, "PAID", false);
    const cancelled = await makeOrder(customer, "CANCELLED", true);

    const detail = await getAdminOrderDetail(ok);
    expect(detail.canMarkSentToPrinter).toBe(true);
    expect(detail.timestamps.sentToPrinterAt).toBeNull();

    const marked = await setOrderSentToPrinter(ok, true, ADMIN);
    const after = await getAdminOrderDetail(ok);
    expect(after.timestamps.sentToPrinterAt).toEqual(marked.sentToPrinterAt);
    expect(after.canMarkSentToPrinter).toBe(true);

    expect((await getAdminOrderDetail(noPdf)).canMarkSentToPrinter).toBe(false);
    expect((await getAdminOrderDetail(cancelled)).canMarkSentToPrinter).toBe(
      false
    );
  });
});

describe("customer responses", () => {
  it("never contain the mark or its date", async () => {
    const id = await makeOrder(customer, "CONFIRMED", true);
    const marked = await setOrderSentToPrinter(id, true, ADMIN);
    const iso = marked.sentToPrinterAt!.toISOString();

    const responses = [
      await listUserOrders(customer),
      await getUserOrder(id, customer),
      await getTrackingForUser(id, customer),
    ];
    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).not.toContain("sentToPrinter");
      expect(json).not.toContain(iso);
    }
    expect(JSON.stringify(responses[0])).toContain(id);
  });
});
