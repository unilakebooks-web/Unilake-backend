// Admin orders list (feature 5, G10): the new awaitingCustomerPrint filter, and the existing filters unchanged.
// Expected values for the existing filters were captured from the code before this change.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { listAdminOrders } from "../../src/services/order.service.js";

const MARK = "__vitest_baseline_orders__";
let comicId = "";
async function cleanup() {
  await prisma.order.deleteMany({
    where: { orderSession: { comic: { title: { startsWith: MARK } } } },
  });
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}
beforeAll(async () => {
  await cleanup();
  comicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} Book`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    })
  ).id;
  const specs: [string, string, string | null][] = [
    ["GENERATED", "PAID_PAGES_READY", null],
    ["GENERATED", "PAID_PAGES_READY", "2026-11-01T00:00:00Z"],
    ["GENERATED", "PAID", null],
    ["CONFIRMED", "CONFIRMED", "2026-11-02T00:00:00Z"],
    ["PAID", "PAID", null],
    ["DELIVERED", "CONFIRMED", null],
  ];
  let i = 0;
  for (const [status, sstatus, sent] of specs) {
    i += 1;
    const s = await prisma.orderSession.create({
      data: {
        comicId,
        status: sstatus as never,
        expiresAt: new Date("2030-01-01"),
        notificationEmail: `b${i}@vitest-baseline.test`,
        childName: `Kid${i}`,
      },
    });
    await prisma.order.create({
      data: {
        id: `${MARK}-${i}`,
        orderSessionId: s.id,
        amount: "100.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "SOFTCOVER",
        status: status as never,
        sentToPrinterAt: sent ? new Date(sent) : null,
        createdAt: new Date(`2026-10-0${i}T00:00:00Z`),
      },
    });
  }
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const ids = (r: any) => r.orders.map((o: any) => o.id.slice(-1));
const list = (extra: object) =>
  listAdminOrders({
    page: 1,
    pageSize: 100,
    sortBy: "createdAt",
    sortOrder: "asc",
    search: MARK,
    ...extra,
  } as never);

describe("admin orders filters", () => {
  it("the existing filters return what they returned before", async () => {
    expect(ids(await list({}))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ids(await list({ status: "GENERATED" }))).toEqual(["1", "2", "3"]);
    expect(ids(await list({ status: "CONFIRMED" }))).toEqual(["4"]);
    expect(ids(await list({ sentToPrinter: "sent" }))).toEqual(["2", "4"]);
    expect(ids(await list({ sentToPrinter: "not_sent" }))).toEqual([
      "1",
      "3",
      "5",
      "6",
    ]);
    expect(
      ids(await list({ status: "GENERATED", sentToPrinter: "not_sent" }))
    ).toEqual(["1", "3"]);
    expect(ids(await list({ search: "Kid3" }))).toEqual(["3"]);
  });

  it("awaitingCustomerPrint: only paid books that are ready, and it combines with the other filters", async () => {
    expect(ids(await list({ awaitingCustomerPrint: "true" }))).toEqual([
      "1",
      "2",
    ]);
    expect(
      ids(await list({ awaitingCustomerPrint: "true", status: "GENERATED" }))
    ).toEqual(["1", "2"]);
    expect(
      ids(await list({ awaitingCustomerPrint: "true", status: "CONFIRMED" }))
    ).toEqual([]);
    expect(
      ids(
        await list({ awaitingCustomerPrint: "true", sentToPrinter: "not_sent" })
      )
    ).toEqual(["1"]);
    const r: any = await list({ awaitingCustomerPrint: "true" });
    expect(r.pagination.total).toBe(2);
  });

  it("the query schema accepts only awaitingCustomerPrint=true", async () => {
    const { listAdminOrdersQuerySchema } =
      await import("../../src/validators/order.schema.js");
    expect(
      listAdminOrdersQuerySchema.safeParse({ awaitingCustomerPrint: "true" })
        .success
    ).toBe(true);
    expect(
      listAdminOrdersQuerySchema.safeParse({ awaitingCustomerPrint: "false" })
        .success
    ).toBe(false);
    expect(listAdminOrdersQuerySchema.safeParse({}).success).toBe(true);
  });
});
