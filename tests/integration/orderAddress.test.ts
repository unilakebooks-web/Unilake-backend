// Integration tests for an admin changing an order's delivery address: who may,
// until when, the history, the sync with Shiprocket (mocked: no real call), and
// the two checks that stop "Generate AWB" while Shiprocket may hold the old
// address. They run against the Neon TEST branch only: the setup import below
// refuses any other database.
import "../setup/env.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Shiprocket is replaced piece by piece (never the database client): the real
// module stays for everything these tests do not touch.
vi.mock("../../src/lib/shiprocket.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/shiprocket.js")>();
  return {
    ...actual,
    updateOrderAddress: vi.fn(),
    getOrderAddress: vi.fn(),
    updateOrder: vi.fn(),
    assignAwb: vi.fn(),
    generatePickup: vi.fn(),
  };
});
// The read-back waits between reads; tests do not.
vi.mock("../../src/config/orderAddress.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/orderAddress.js")>();
  return { ...actual, ADDRESS_READBACK_DELAY_MS: 0 };
});
vi.mock(
  "../../src/services/notification.service.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/notification.service.js")
      >();
    return {
      ...actual,
      notifyAwbGenerated: vi.fn().mockResolvedValue(undefined),
    };
  }
);

import { prisma } from "../../src/lib/prisma.js";
import * as shiprocket from "../../src/lib/shiprocket.js";
import {
  assertAddressSyncedForAwb,
  editOrderAddress,
  getAddressEditState,
  markOrderAddressSynced,
  syncOrderAddress,
} from "../../src/services/orderAddress.service.js";
import { getAdminOrderDetail } from "../../src/services/order.service.js";
import { buildBillOfSupplyPdf } from "../../src/services/billOfSupply.service.js";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pushDimensionsAssignAwbAndSchedulePickup } from "../../src/services/shiprocket.service.js";
import { AppError } from "../../src/utils/errors.js";
import type {
  AddressSyncStatus,
  OrderStatus,
} from "../../src/generated/prisma/client.js";

const MARK = "__vitest_address__";
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const COMIC_ID = "00000000-0000-4000-8000-000000000100";
const ADMIN = { id: "vitest-admin", email: "admin@example.test" };
const OTHER_ADMIN = { id: "vitest-admin-2", email: "admin2@example.test" };

const getOrderAddress = vi.mocked(shiprocket.getOrderAddress);
const updateOrderAddress = vi.mocked(shiprocket.updateOrderAddress);
const updateOrder = vi.mocked(shiprocket.updateOrder);
const assignAwb = vi.mocked(shiprocket.assignAwb);
const generatePickup = vi.mocked(shiprocket.generatePickup);

const OLD = {
  name: "Old Name",
  line1: "1 Old Street",
  line2: null as string | null,
  city: "Mumbai",
  state: "Maharashtra",
  zip: "400001",
  country: "IN",
  phone: "9999999999",
};

const NEW_INPUT = {
  name: "New Name",
  line1: "2 New Road",
  line2: "Near Park",
  city: "Pune",
  state: "Maharashtra",
  zip: "411001",
  phone: "9123456780",
};

/** What Shiprocket returns for an order that holds the given address. */
function held(a: {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}) {
  return {
    name: a.name,
    line1: a.line1,
    line2: a.line2 ?? "",
    city: a.city,
    state: a.state,
    pincode: a.zip,
    country: "India",
  };
}
const HELD_OLD = held(OLD);
/** The order's current address in the shape the edit takes (phone left to the test). */
const OLD_INPUT = {
  name: OLD.name,
  line1: OLD.line1,
  line2: "",
  city: OLD.city,
  state: OLD.state,
  zip: OLD.zip,
};
const HELD_NEW = held(NEW_INPUT);

let userId: string;

async function makeUser() {
  const id = `${MARK}-${RUN}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  return id;
}

async function makeOrder(opts: {
  status: OrderStatus;
  shiprocketOrderId?: string | null;
  awbNumber?: string | null;
  country?: string;
  phone?: string;
}) {
  const country = opts.country ?? OLD.country;
  const phone = opts.phone ?? OLD.phone;
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId,
      status: "AWAITING_PAYMENT",
      coverType: "HARDCOVER",
      childName: "Vitest",
      shippingName: OLD.name,
      shippingLine1: OLD.line1,
      shippingCity: OLD.city,
      shippingState: OLD.state,
      shippingZip: OLD.zip,
      shippingCountry: country,
      shippingPhone: phone,
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
      status: opts.status,
      shippingName: OLD.name,
      shippingLine1: OLD.line1,
      shippingCity: OLD.city,
      shippingState: OLD.state,
      shippingZip: OLD.zip,
      shippingCountry: country,
      shippingPhone: phone,
      notificationEmail: `${MARK}-${RUN}@example.test`,
      shiprocketOrderId: opts.shiprocketOrderId ?? null,
      shiprocketShipmentId: opts.shiprocketOrderId ? "7777" : null,
      awbNumber: opts.awbNumber ?? null,
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

const rows = (orderId: string) =>
  prisma.orderAddressChange.findMany({
    where: { orderId },
    orderBy: { seq: "asc" },
  });

const readOrder = (id: string) =>
  prisma.order.findUniqueOrThrow({ where: { id } });

async function plantRow(
  orderId: string,
  syncStatus: AddressSyncStatus,
  extra: { syncStartedAt?: Date } = {}
) {
  return prisma.orderAddressChange.create({
    data: {
      orderId,
      before: OLD,
      after: OLD,
      changedById: ADMIN.id,
      changedByEmail: ADMIN.email,
      syncStatus,
      ...extra,
    },
  });
}

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
  const orders = await prisma.order.findMany({
    where: { orderSessionId: { in: sessionIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.orderAddressChange.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  userId = await makeUser();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  getOrderAddress.mockReset();
  updateOrderAddress.mockReset();
  updateOrder.mockReset();
  assignAwb.mockReset();
  generatePickup.mockReset();
});

describe("getAddressEditState", () => {
  const editable: OrderStatus[] = [
    "PAID",
    "GENERATED",
    "CONFIRMED",
    "SHIPROCKET_FAILED",
    "READY_TO_SHIP",
  ];
  it.each(editable)("allows %s without an AWB", (status) => {
    expect(getAddressEditState({ status, awbNumber: null })).toEqual({
      editable: true,
      reason: null,
    });
  });

  it.each(["CREATED", "CANCELLED", "SHIPPED", "DELIVERED"] as OrderStatus[])(
    "refuses %s with a reason",
    (status) => {
      const state = getAddressEditState({ status, awbNumber: null });
      expect(state.editable).toBe(false);
      expect(state.reason).toBeTruthy();
    }
  );

  it("an AWB locks every status", () => {
    for (const status of editable) {
      expect(getAddressEditState({ status, awbNumber: "AWB1" }).editable).toBe(
        false
      );
    }
  });
});

describe("editOrderAddress, saving", () => {
  it("changes the order and the session copy, keeps the history, touches no money field", async () => {
    const id = await makeOrder({ status: "PAID" });
    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);

    expect(result.changed).toBe(true);
    const order = await readOrder(id);
    expect(order.shippingName).toBe("New Name");
    expect(order.shippingLine2).toBe("Near Park");
    expect(order.shippingZip).toBe("411001");
    expect(order.shippingCountry).toBe("IN"); // not editable
    expect(order.amount.toString()).toBe("999");
    expect(order.currency).toBe("INR");
    expect(order.countryCode).toBe("IN");

    const session = await prisma.orderSession.findUniqueOrThrow({
      where: { id: order.orderSessionId },
    });
    expect(session.shippingName).toBe("New Name");
    expect(session.shippingCity).toBe("Pune");

    const history = await rows(id);
    expect(history).toHaveLength(1);
    expect(history[0]!.before).toMatchObject({
      name: "Old Name",
      zip: "400001",
    });
    expect(history[0]!.after).toMatchObject({
      name: "New Name",
      zip: "411001",
      country: "IN",
    });
    expect(history[0]!.changedById).toBe(ADMIN.id);
    expect(history[0]!.changedByEmail).toBe(ADMIN.email);
    // PAID: no Shiprocket order can exist or be in the making.
    expect(history[0]!.syncStatus).toBe("NOT_REQUIRED");
    expect(getOrderAddress).not.toHaveBeenCalled();
    expect(updateOrderAddress).not.toHaveBeenCalled();
  });

  it("does nothing, and writes no row, when nothing changed (extra spacing aside)", async () => {
    const id = await makeOrder({ status: "PAID" });
    const result = await editOrderAddress(
      id,
      {
        ...NEW_INPUT,
        name: "  Old   Name ",
        line1: "1  Old Street",
        line2: "",
        city: "Mumbai",
        state: "Maharashtra",
        zip: "400001",
        phone: "9999999999",
      },
      ADMIN
    );
    expect(result.changed).toBe(false);
    expect(await rows(id)).toHaveLength(0);
  });

  it("a correction of capitalisation alone is a change and is saved", async () => {
    const id = await makeOrder({ status: "PAID" });
    const result = await editOrderAddress(
      id,
      {
        ...NEW_INPUT,
        name: "Old Name",
        line1: "1 Old Street",
        line2: "",
        city: "MUMBAI",
        state: "Maharashtra",
        zip: "400001",
        phone: "9999999999",
      },
      ADMIN
    );
    expect(result.changed).toBe(true);
    expect((await readOrder(id)).shippingCity).toBe("MUMBAI");
    expect(await rows(id)).toHaveLength(1);
  });

  it("stores an empty line 2 as null", async () => {
    const id = await makeOrder({ status: "PAID" });
    await editOrderAddress(id, { ...NEW_INPUT, line2: "   " }, ADMIN);
    expect((await readOrder(id)).shippingLine2).toBeNull();
  });

  it.each(["CREATED", "CANCELLED", "SHIPPED", "DELIVERED"] as OrderStatus[])(
    "refuses an order that is %s, and changes nothing",
    async (status) => {
      const id = await makeOrder({ status });
      const error = await refusal(editOrderAddress(id, NEW_INPUT, ADMIN));
      expect(error?.statusCode).toBe(409);
      expect((await readOrder(id)).shippingName).toBe("Old Name");
      expect(await rows(id)).toHaveLength(0);
    }
  );

  it("refuses once the AWB exists", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
      awbNumber: "AWB9",
    });
    const error = await refusal(editOrderAddress(id, NEW_INPUT, ADMIN));
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/AWB/);
  });

  it("answers 404 for an unknown order", async () => {
    const error = await refusal(
      editOrderAddress("00000000-0000-4000-8000-0000000000ff", NEW_INPUT, ADMIN)
    );
    expect(error?.statusCode).toBe(404);
  });
});

describe("editOrderAddress, input rules checked against the order", () => {
  it("an Indian order needs a 6-digit pincode", async () => {
    const id = await makeOrder({ status: "PAID" });
    const error = await refusal(
      editOrderAddress(id, { ...NEW_INPUT, zip: "41100" }, ADMIN)
    );
    expect(error?.statusCode).toBe(400);
    expect((await readOrder(id)).shippingZip).toBe("400001");
  });

  it("an international order is not held to the Indian pincode rule", async () => {
    const id = await makeOrder({ status: "PAID", country: "GB" });
    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, zip: "12345" },
      ADMIN
    );
    expect(result.changed).toBe(true);
  });

  it("an order Shiprocket already holds needs a 10-digit phone", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const error = await refusal(
      editOrderAddress(id, { ...NEW_INPUT, phone: "12345678901" }, ADMIN)
    );
    expect(error?.statusCode).toBe(400);
    expect(updateOrderAddress).not.toHaveBeenCalled();
  });

  it("the phone rules apply before Shiprocket holds the order too: an Indian order needs 10 digits, none starts with 0", async () => {
    const id = await makeOrder({ status: "PAID" });
    expect(
      (
        await refusal(
          editOrderAddress(id, { ...NEW_INPUT, phone: "1234567" }, ADMIN)
        )
      )?.statusCode
    ).toBe(400);
    expect(
      (
        await refusal(
          editOrderAddress(id, { ...NEW_INPUT, phone: "0123456789" }, ADMIN)
        )
      )?.statusCode
    ).toBe(400);
    expect((await readOrder(id)).shippingPhone).toBe("9999999999");
  });

  it("an international order may use another phone length", async () => {
    const id = await makeOrder({ status: "PAID", country: "GB" });
    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, zip: "12345", phone: "1234567" },
      ADMIN
    );
    expect(result.changed).toBe(true);
  });
});

describe("sync state follows the order status", () => {
  it.each(["CONFIRMED", "SHIPROCKET_FAILED"] as OrderStatus[])(
    "%s with no Shiprocket order yet: PENDING, no call, retry refused, AWB blocked",
    async (status) => {
      const id = await makeOrder({ status });
      const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
      expect(result).toMatchObject({ changed: true, syncStatus: "PENDING" });
      expect(getOrderAddress).not.toHaveBeenCalled();
      expect(updateOrderAddress).not.toHaveBeenCalled();

      const retry = await refusal(syncOrderAddress(id, ADMIN));
      expect(retry?.statusCode).toBe(409);
      expect(retry?.message).toMatch(/not been created yet/);

      const blocked = await refusal(assertAddressSyncedForAwb(id));
      expect(blocked?.statusCode).toBe(409);
    }
  );
});

describe("sync with Shiprocket", () => {
  it("reads, pushes the new address, reads back, and marks SYNCED", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress
      .mockResolvedValueOnce(HELD_OLD) // first read: Shiprocket still has the old address
      .mockResolvedValue(HELD_NEW); // after the push
    updateOrderAddress.mockResolvedValue(undefined);

    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);

    expect(result).toMatchObject({ changed: true, syncStatus: "SYNCED" });
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
    expect(updateOrderAddress).toHaveBeenCalledWith({
      shiprocketOrderId: "555",
      name: "New Name",
      phone: "9123456780",
      line1: "2 New Road",
      line2: "Near Park",
      city: "Pune",
      state: "Maharashtra",
      country: "India", // the name Shiprocket stores, taken from the read
      pincode: "411001",
    });
    const [row] = await rows(id);
    expect(row!.syncStatus).toBe("SYNCED");
    expect(row!.syncedByEmail).toBe(ADMIN.email);
    expect(row!.syncStartedAt).toBeNull();
    await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
  });

  it("does not push when Shiprocket already holds the address", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_NEW);
    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, phone: OLD.phone }, // a phone change is always pushed, so keep it out of this case
      ADMIN
    );
    expect(result).toMatchObject({ syncStatus: "SYNCED" });
    expect(updateOrderAddress).not.toHaveBeenCalled();
  });

  it("a refused push is FAILED with a fixed message that never echoes Shiprocket's reply; the change stays saved", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockRejectedValue(
      new Error("422 bad: 2 New Road, Pune 9123456780")
    );

    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);

    expect(result).toMatchObject({ changed: true, syncStatus: "FAILED" });
    expect((await readOrder(id)).shippingName).toBe("New Name");
    const [row] = await rows(id);
    expect(row!.syncError).toBe("Shiprocket did not accept the new address");
    expect(JSON.stringify(row)).not.toMatch(/2 New Road, Pune|9123456780 /);
    const blocked = await refusal(assertAddressSyncedForAwb(id));
    expect(blocked?.statusCode).toBe(409);
  });

  it("retry after a failure pushes the CURRENT address and covers every unsynced row", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockRejectedValue(new Error("down"));
    await editOrderAddress(id, NEW_INPUT, ADMIN);
    const SECOND = { ...NEW_INPUT, line1: "3 Third Lane", zip: "411002" };
    await editOrderAddress(id, SECOND, ADMIN);
    expect((await rows(id)).map((r) => r.syncStatus)).toEqual([
      "FAILED",
      "FAILED",
    ]);

    getOrderAddress.mockReset();
    updateOrderAddress.mockReset();
    getOrderAddress
      .mockResolvedValueOnce(HELD_OLD)
      .mockResolvedValue(held({ ...SECOND }));
    updateOrderAddress.mockResolvedValue(undefined);
    const result = await syncOrderAddress(id, OTHER_ADMIN);

    expect(result).toMatchObject({ status: "SYNCED", covered: 2 });
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
    expect(updateOrderAddress.mock.calls[0]![0]).toMatchObject({
      line1: "3 Third Lane",
      pincode: "411002",
    });
    expect((await rows(id)).map((r) => r.syncStatus)).toEqual([
      "SYNCED",
      "SYNCED",
    ]);
    await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
  });

  it("a read-back that never shows the change is FAILED", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockResolvedValue(undefined);
    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
    expect(result).toMatchObject({ syncStatus: "FAILED" });
    expect(getOrderAddress).toHaveBeenCalledTimes(1 + 3); // one read first, three after the push
    const [row] = await rows(id);
    expect(row!.syncError).toBe("Shiprocket has not applied the change yet");
  });

  it("a blank read-back is UNVERIFIED, and so is a read that fails, and both block the AWB", async () => {
    const blank = {
      name: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      pincode: "",
      country: "",
    };
    const a = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValueOnce(HELD_OLD).mockResolvedValue(blank);
    updateOrderAddress.mockResolvedValue(undefined);
    expect(await editOrderAddress(a, NEW_INPUT, ADMIN)).toMatchObject({
      syncStatus: "UNVERIFIED",
    });
    expect((await refusal(assertAddressSyncedForAwb(a)))?.statusCode).toBe(409);

    getOrderAddress.mockReset();
    const b = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "556",
    });
    getOrderAddress
      .mockResolvedValueOnce(HELD_OLD)
      .mockRejectedValue(new Error("timeout"));
    expect(await editOrderAddress(b, NEW_INPUT, ADMIN)).toMatchObject({
      syncStatus: "UNVERIFIED",
    });
  });

  it("a phone that Shiprocket cannot take is FAILED up front, with no push", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "PENDING");
    await prisma.order.update({
      where: { id },
      data: { shippingPhone: "12345" },
    });
    getOrderAddress.mockResolvedValue(HELD_NEW); // differs from the order, so a push would be needed
    const result = await syncOrderAddress(id, ADMIN);
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/10-digit/);
    expect(updateOrderAddress).not.toHaveBeenCalled();
  });

  it("an edit made while a push is running stays PENDING and is not covered by that sync", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const SECOND = { ...NEW_INPUT, line1: "9 Later Street" };
    getOrderAddress.mockResolvedValueOnce(HELD_OLD).mockResolvedValue(HELD_NEW);
    updateOrderAddress.mockImplementation(async () => {
      // The second edit commits while the first push is in flight; its own sync
      // cannot start (the first claim is fresh), so it stays PENDING.
      const during = await editOrderAddress(id, SECOND, OTHER_ADMIN);
      expect(during).toMatchObject({ changed: true, syncStatus: "PENDING" });
    });

    const first = await editOrderAddress(id, NEW_INPUT, ADMIN);

    expect(first).toMatchObject({ syncStatus: "SYNCED" });
    const history = await rows(id);
    expect(history.map((r) => r.syncStatus)).toEqual(["SYNCED", "PENDING"]);
    expect((await refusal(assertAddressSyncedForAwb(id)))?.statusCode).toBe(
      409
    );
  });
});

describe("sync claims", () => {
  it("refuses a second sync while a fresh claim exists", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "SYNCING", { syncStartedAt: new Date() });
    await plantRow(id, "PENDING");
    const error = await refusal(syncOrderAddress(id, ADMIN));
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/in progress/);
  });

  it("takes over a claim older than five minutes", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "SYNCING", {
      syncStartedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    getOrderAddress.mockResolvedValue(held({ ...OLD }));
    const result = await syncOrderAddress(id, ADMIN);
    expect(result).toMatchObject({ status: "SYNCED", covered: 1 });
  });

  it("refuses when there is nothing to sync, and after the AWB", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    expect((await refusal(syncOrderAddress(id, ADMIN)))?.statusCode).toBe(409);
    await plantRow(id, "FAILED");
    await prisma.order.update({ where: { id }, data: { awbNumber: "AWB1" } });
    const error = await refusal(syncOrderAddress(id, ADMIN));
    expect(error?.message).toMatch(/AWB/);
  });
});

describe("concurrent edits", () => {
  it("two different edits at once are both kept, in order, with an unbroken before/after chain", async () => {
    const id = await makeOrder({ status: "PAID" });
    await Promise.all([
      editOrderAddress(id, NEW_INPUT, ADMIN),
      editOrderAddress(
        id,
        { ...NEW_INPUT, line1: "7 Other Road", zip: "411005" },
        OTHER_ADMIN
      ),
    ]);
    const history = await rows(id);
    expect(history).toHaveLength(2);
    expect(history[1]!.seq).toBeGreaterThan(history[0]!.seq);
    expect(history[0]!.before).toMatchObject({ name: "Old Name" });
    expect(history[1]!.before).toEqual(history[0]!.after); // nothing lost, nothing forked
    expect((await readOrder(id)).shippingLine1).toBe(
      (history[1]!.after as { line1: string }).line1
    );
  });

  it("the same edit sent twice at once leaves one row", async () => {
    const id = await makeOrder({ status: "PAID" });
    await Promise.all([
      editOrderAddress(id, NEW_INPUT, ADMIN),
      editOrderAddress(id, NEW_INPUT, ADMIN),
    ]);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("markOrderAddressSynced", () => {
  const NOTE = "checked in the Shiprocket panel";

  it("records the note, who and when, and unblocks the AWB", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "FAILED");
    const newest = await plantRow(id, "UNVERIFIED");
    const result = await markOrderAddressSynced(
      id,
      { note: `  ${NOTE} `, upToSeq: newest.seq },
      ADMIN
    );
    expect(result.marked).toBe(2);
    for (const row of await rows(id)) {
      expect(row.syncStatus).toBe("MANUAL");
      expect(row.syncNote).toBe(NOTE);
      expect(row.syncedByEmail).toBe(ADMIN.email);
      expect(row.syncedAt).toBeInstanceOf(Date);
    }
    await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
  });

  it("never marks a change the admin did not see: a newer one is refused and left untouched", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const seen = await plantRow(id, "FAILED");
    const later = await plantRow(id, "PENDING"); // another admin edits after the dialog was opened
    const error = await refusal(
      markOrderAddressSynced(id, { note: NOTE, upToSeq: seen.seq }, ADMIN)
    );
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/changed again/);
    expect((await rows(id)).map((r) => r.syncStatus)).toEqual([
      "FAILED",
      "PENDING",
    ]);
    // Once the admin has seen the newer change too, it works.
    const result = await markOrderAddressSynced(
      id,
      { note: NOTE, upToSeq: later.seq },
      ADMIN
    );
    expect(result.marked).toBe(2);
  });

  it("refuses when there is no Shiprocket order to check", async () => {
    const id = await makeOrder({ status: "CONFIRMED" });
    const row = await plantRow(id, "PENDING");
    const error = await refusal(
      markOrderAddressSynced(id, { note: NOTE, upToSeq: row.seq }, ADMIN)
    );
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/no Shiprocket order/);
    expect((await rows(id))[0]!.syncStatus).toBe("PENDING");
  });

  it("refuses with nothing to mark, with a fresh sync running, and after the AWB", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    expect(
      (
        await refusal(
          markOrderAddressSynced(id, { note: NOTE, upToSeq: 1 }, ADMIN)
        )
      )?.statusCode
    ).toBe(409);
    const running = await plantRow(id, "SYNCING", {
      syncStartedAt: new Date(),
    });
    expect(
      (
        await refusal(
          markOrderAddressSynced(
            id,
            { note: NOTE, upToSeq: running.seq },
            ADMIN
          )
        )
      )?.statusCode
    ).toBe(409);
    await prisma.order.update({ where: { id }, data: { awbNumber: "AWB1" } });
    expect(
      (
        await refusal(
          markOrderAddressSynced(
            id,
            { note: NOTE, upToSeq: running.seq },
            ADMIN
          )
        )
      )?.message
    ).toMatch(/AWB/);
  });
});

describe("changes the Shiprocket read cannot prove", () => {
  it("a phone-only change is always pushed, even when everything else already matches", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD); // the read shows no phone, and the rest matches
    updateOrderAddress.mockResolvedValue(undefined);

    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, ...OLD_INPUT, phone: "9123456780" },
      ADMIN
    );

    expect(result).toMatchObject({ changed: true, syncStatus: "SYNCED" });
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
    expect(updateOrderAddress.mock.calls[0]![0]).toMatchObject({
      phone: "9123456780",
    });
    // Shiprocket masks the phone, so it was sent, not confirmed: the row says so.
    const [row] = await rows(id);
    expect(row!.syncStatus).toBe("SYNCED");
    expect(row!.syncNote).toMatch(/cannot be read back/);
  });

  it("a correction of capitalisation alone is pushed, and a Shiprocket that keeps the old case still confirms it", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD); // Shiprocket has "Mumbai", before and after the push
    updateOrderAddress.mockResolvedValue(undefined);

    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, ...OLD_INPUT, phone: OLD.phone, city: "MUMBAI" }, // phone kept, so only the case differs
      ADMIN
    );

    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ syncStatus: "SYNCED" });
  });
});

describe("phone and pincode rules that depend on the order", () => {
  it("a leading 0 in the phone is refused once Shiprocket holds the order", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const error = await refusal(
      editOrderAddress(id, { ...NEW_INPUT, phone: "0123456789" }, ADMIN)
    );
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toMatch(/start with 0/);
  });

  it("an international order may keep a phone of another length (Shiprocket decides)", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
      country: "GB",
    });
    getOrderAddress.mockResolvedValue({
      ...HELD_OLD,
      country: "United Kingdom",
    });
    updateOrderAddress.mockResolvedValue(undefined);
    const result = await editOrderAddress(
      id,
      { ...NEW_INPUT, zip: "12345", phone: "44123456789" },
      ADMIN
    );
    expect(result.changed).toBe(true);
    expect(updateOrderAddress.mock.calls[0]![0]).toMatchObject({
      country: "United Kingdom",
      phone: "44123456789",
    });
  });

  it("an Indian pincode must not start with 0", async () => {
    const id = await makeOrder({ status: "PAID" });
    const error = await refusal(
      editOrderAddress(id, { ...NEW_INPUT, zip: "012345" }, ADMIN)
    );
    expect(error?.statusCode).toBe(400);
  });
});

describe("a change made before Shiprocket has the order", () => {
  it("waits as PENDING, and once the order exists a retry confirms it without a push when Shiprocket already holds it", async () => {
    const id = await makeOrder({ status: "CONFIRMED" });
    await editOrderAddress(id, { ...NEW_INPUT, phone: OLD.phone }, ADMIN);
    expect((await rows(id))[0]!.syncStatus).toBe("PENDING");

    // Phase A then creates the Shiprocket order from the saved address.
    await prisma.order.update({
      where: { id },
      data: {
        shiprocketOrderId: "556",
        shiprocketShipmentId: "7777",
        status: "READY_TO_SHIP",
      },
    });
    getOrderAddress.mockResolvedValue(HELD_NEW);
    const result = await syncOrderAddress(id, ADMIN);

    expect(result.status).toBe("SYNCED");
    expect(updateOrderAddress).not.toHaveBeenCalled();
    await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
  });

  it("and pushes when Shiprocket was built from the old address (Phase A read it before the edit)", async () => {
    const id = await makeOrder({ status: "CONFIRMED" });
    await editOrderAddress(id, { ...NEW_INPUT, phone: OLD.phone }, ADMIN);
    await prisma.order.update({
      where: { id },
      data: {
        shiprocketOrderId: "557",
        shiprocketShipmentId: "7777",
        status: "READY_TO_SHIP",
      },
    });
    getOrderAddress.mockResolvedValueOnce(HELD_OLD).mockResolvedValue(HELD_NEW);
    updateOrderAddress.mockResolvedValue(undefined);

    const result = await syncOrderAddress(id, ADMIN);

    expect(result.status).toBe("SYNCED");
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
  });
});

describe("two retries at once", () => {
  it("push once; the other is told a sync is in progress", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "FAILED");
    getOrderAddress
      .mockResolvedValueOnce(HELD_NEW)
      .mockResolvedValue(held(OLD));
    updateOrderAddress.mockResolvedValue(undefined);

    const results = await Promise.allSettled([
      syncOrderAddress(id, ADMIN),
      syncOrderAddress(id, OTHER_ADMIN),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect((rejected.reason as AppError).statusCode).toBe(409);
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
  });
});

describe("a Shiprocket order that already exists in CONFIRMED and SHIPROCKET_FAILED", () => {
  it.each(["CONFIRMED", "SHIPROCKET_FAILED"] as OrderStatus[])(
    "%s with its ids: the change is pushed at once and confirmed",
    async (status) => {
      const id = await makeOrder({ status, shiprocketOrderId: "555" });
      getOrderAddress
        .mockResolvedValueOnce(HELD_OLD)
        .mockResolvedValue(HELD_NEW);
      updateOrderAddress.mockResolvedValue(undefined);
      const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
      expect(result).toMatchObject({ changed: true, syncStatus: "SYNCED" });
      expect(updateOrderAddress).toHaveBeenCalledTimes(1);
      await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
    }
  );
});

describe("two admins with the same older form", () => {
  it("at once: exactly one is saved, the other is told the address changed", async () => {
    const id = await makeOrder({ status: "PAID" });
    const results = await Promise.allSettled([
      editOrderAddress(id, { ...NEW_INPUT, expectedSeq: 0 }, ADMIN),
      editOrderAddress(
        id,
        { ...NEW_INPUT, line1: "5 Other Road", expectedSeq: 0 },
        OTHER_ADMIN
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect((rejected.reason as AppError).statusCode).toBe(409);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("line 2 left out of the request", () => {
  it("clears line 2 (the form always sends it; a direct client that omits it empties it)", async () => {
    const id = await makeOrder({ status: "PAID" });
    await prisma.order.update({
      where: { id },
      data: { shippingLine2: "Near the old park" },
    });
    const { line2: _line2, ...withoutLine2 } = NEW_INPUT;
    await editOrderAddress(id, withoutLine2, ADMIN);
    expect((await readOrder(id)).shippingLine2).toBeNull();
  });
});

describe("claim boundary, timeouts and read failures", () => {
  it("a claim 4 minutes 30 seconds old is still running, so a sync is refused", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "SYNCING", {
      syncStartedAt: new Date(Date.now() - 270_000),
    });
    const error = await refusal(syncOrderAddress(id, ADMIN));
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/in progress/);
  });

  it("a claim 5 minutes 30 seconds old is abandoned and is taken over", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "SYNCING", {
      syncStartedAt: new Date(Date.now() - 330_000),
    });
    getOrderAddress.mockResolvedValue(held({ ...OLD }));
    expect(await syncOrderAddress(id, ADMIN)).toMatchObject({
      status: "SYNCED",
      covered: 1,
    });
  });

  it("a push that times out is FAILED with the fixed message, and a retry from there works", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      )
    );
    expect(await editOrderAddress(id, NEW_INPUT, ADMIN)).toMatchObject({
      syncStatus: "FAILED",
    });
    expect((await rows(id))[0]!.syncError).toBe(
      "Shiprocket did not accept the new address"
    );

    getOrderAddress.mockReset();
    updateOrderAddress.mockReset();
    getOrderAddress.mockResolvedValueOnce(HELD_OLD).mockResolvedValue(HELD_NEW);
    updateOrderAddress.mockResolvedValue(undefined);
    expect(await syncOrderAddress(id, ADMIN)).toMatchObject({
      status: "SYNCED",
    });
  });

  it("a first read that fails does not stop the push", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValue(HELD_NEW);
    updateOrderAddress.mockResolvedValue(undefined);
    // Without the first read the country name comes from the country table (India is seeded).
    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
    expect(result).toMatchObject({ syncStatus: "SYNCED" });
    expect(updateOrderAddress).toHaveBeenCalledTimes(1);
    expect(updateOrderAddress.mock.calls[0]![0]).toMatchObject({
      country: "India",
    });
  });

  it("a retry starting from UNVERIFIED confirms it once Shiprocket shows the address", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    await plantRow(id, "UNVERIFIED");
    getOrderAddress.mockResolvedValue(held({ ...OLD }));
    expect(await syncOrderAddress(id, ADMIN)).toMatchObject({
      status: "SYNCED",
      covered: 1,
    });
    await expect(assertAddressSyncedForAwb(id)).resolves.toBeUndefined();
  });

  it("an order whose country Shiprocket does not name and our table does not know is FAILED, with no push", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
      country: "ZZ",
    });
    getOrderAddress.mockResolvedValue({ ...HELD_OLD, country: "" });
    const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
    expect(result).toMatchObject({ syncStatus: "FAILED" });
    expect(updateOrderAddress).not.toHaveBeenCalled();
    expect((await rows(id))[0]!.syncError).toBe(
      "The address could not be synced"
    );
  });

  it("the session copy is updated even when the session is past the customer's editing", async () => {
    const id = await makeOrder({ status: "PAID" });
    const order = await readOrder(id);
    await prisma.orderSession.update({
      where: { id: order.orderSessionId },
      data: { status: "COMPLETED" },
    });
    await editOrderAddress(id, NEW_INPUT, ADMIN);
    const session = await prisma.orderSession.findUniqueOrThrow({
      where: { id: order.orderSessionId },
    });
    expect(session.shippingName).toBe("New Name");
  });
});

describe("Generate AWB (Phase B) guards", () => {
  const DIMENSIONS = { length: 20, breadth: 20, height: 2, weight: 0.5 };

  function arrangeShiprocket() {
    updateOrder.mockResolvedValue({} as never);
    assignAwb.mockResolvedValue({
      awbCode: "AWB-TEST-1",
      courierId: 1,
      courierName: "Test Courier",
      awbGeneratedAt: new Date(),
    } as never);
    generatePickup.mockResolvedValue({
      pickupScheduledDate: null,
      pickupGeneratedAt: new Date(),
    } as never);
  }

  it("books the AWB as before when the order has no address history", async () => {
    arrangeShiprocket();
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const result = await pushDimensionsAssignAwbAndSchedulePickup(
      id,
      DIMENSIONS
    );
    expect(result.awbCode).toBe("AWB-TEST-1");
    expect((await readOrder(id)).awbNumber).toBe("AWB-TEST-1");
  });

  it.each(["SYNCED", "MANUAL", "NOT_REQUIRED"] as AddressSyncStatus[])(
    "books the AWB when the history is %s",
    async (syncStatus) => {
      arrangeShiprocket();
      const id = await makeOrder({
        status: "READY_TO_SHIP",
        shiprocketOrderId: "555",
      });
      await plantRow(id, syncStatus);
      await expect(
        pushDimensionsAssignAwbAndSchedulePickup(id, DIMENSIONS)
      ).resolves.toBeTruthy();
    }
  );

  it.each([
    "PENDING",
    "SYNCING",
    "FAILED",
    "UNVERIFIED",
  ] as AddressSyncStatus[])(
    "refuses while a change is %s, before any Shiprocket call",
    async (syncStatus) => {
      arrangeShiprocket();
      const id = await makeOrder({
        status: "READY_TO_SHIP",
        shiprocketOrderId: "555",
      });
      await plantRow(id, syncStatus);
      const error = await refusal(
        pushDimensionsAssignAwbAndSchedulePickup(id, DIMENSIONS)
      );
      expect(error?.statusCode).toBe(409);
      expect(updateOrder).not.toHaveBeenCalled();
      expect(assignAwb).not.toHaveBeenCalled();
      expect((await readOrder(id)).awbNumber).toBeNull();
    }
  );

  it("refuses just before the AWB when the address changed while it was being prepared", async () => {
    arrangeShiprocket();
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    updateOrder.mockImplementation(async () => {
      await plantRow(id, "PENDING"); // an admin edit lands during the Shiprocket update call
      return {} as never;
    });
    const error = await refusal(
      pushDimensionsAssignAwbAndSchedulePickup(id, DIMENSIONS)
    );
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/changed while/);
    expect(assignAwb).not.toHaveBeenCalled();
    expect((await readOrder(id)).awbNumber).toBeNull();
  });
});

describe("an edit that lands during the AWB call", () => {
  it("is closed as FAILED with a message to check the label, and the AWB still stands", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    updateOrder.mockResolvedValue({} as never);
    generatePickup.mockResolvedValue({
      pickupScheduledDate: null,
      pickupGeneratedAt: new Date(),
    } as never);
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockRejectedValue(new Error("too late"));
    assignAwb.mockImplementation(async () => {
      // A second admin saves the new address while the courier assignment is in flight.
      await editOrderAddress(id, NEW_INPUT, OTHER_ADMIN);
      return {
        awbCode: "AWB-LATE-1",
        courierId: 1,
        courierName: "Test Courier",
        awbGeneratedAt: new Date(),
      } as never;
    });

    await pushDimensionsAssignAwbAndSchedulePickup(id, {
      length: 20,
      breadth: 20,
      height: 2,
      weight: 0.5,
    });

    expect((await readOrder(id)).awbNumber).toBe("AWB-LATE-1");
    const [row] = await rows(id);
    expect(row!.syncStatus).toBe("FAILED");
    expect(row!.syncError).toMatch(
      /AWB was created while this change was being made/
    );
    const detail = await getAdminOrderDetail(id);
    expect(detail.addressEditable.editable).toBe(false);
    expect(detail.addressHistory[0]!.syncError).toMatch(/Check that the label/);
  });
});

describe("an edit that lands during the AWB call and syncs in time", () => {
  it("keeps its SYNCED status but carries the check-the-label note, and a second Generate AWB gets the real refusal", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    updateOrder.mockResolvedValue({} as never);
    generatePickup.mockResolvedValue({
      pickupScheduledDate: null,
      pickupGeneratedAt: new Date(),
    } as never);
    getOrderAddress.mockResolvedValueOnce(HELD_OLD).mockResolvedValue(HELD_NEW);
    updateOrderAddress.mockResolvedValue(undefined);
    assignAwb.mockImplementation(async () => {
      await editOrderAddress(id, NEW_INPUT, OTHER_ADMIN); // pushed and confirmed in time
      return {
        awbCode: "AWB-LATE-2",
        courierId: 1,
        courierName: "Test Courier",
        awbGeneratedAt: new Date(),
      } as never;
    });
    const dims = { length: 20, breadth: 20, height: 2, weight: 0.5 };

    await pushDimensionsAssignAwbAndSchedulePickup(id, dims);

    const [row] = await rows(id);
    expect(row!.syncStatus).toBe("SYNCED");
    expect(row!.syncError).toMatch(
      /AWB was created while this change was being made/
    );

    // A repeat press must say "already has an AWB", not talk about an address change.
    const again = await refusal(
      pushDimensionsAssignAwbAndSchedulePickup(id, dims)
    );
    expect(again?.statusCode).toBe(409);
    expect(again?.message).toMatch(/already has an AWB/);
  });
});

describe("the admin order detail", () => {
  it("returns the history newest first and whether the address may change", async () => {
    const id = await makeOrder({ status: "PAID" });
    await editOrderAddress(id, NEW_INPUT, ADMIN);
    await editOrderAddress(
      id,
      { ...NEW_INPUT, line1: "4 Fourth Avenue" },
      ADMIN
    );
    const detail = await getAdminOrderDetail(id);
    expect(detail.addressEditable).toEqual({ editable: true, reason: null });
    expect(detail.addressHistory).toHaveLength(2);
    expect(detail.addressHistory[0]!.seq).toBeGreaterThan(
      detail.addressHistory[1]!.seq
    );
    expect(detail.addressHistory[0]!.changedByEmail).toBe(ADMIN.email);
    expect(detail.shipping.line1).toBe("4 Fourth Avenue");
    expect(detail.amount).toBe("999");
  });

  it("an order with no history has an empty list, and a locked order says why", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
      awbNumber: "AWB7",
    });
    const detail = await getAdminOrderDetail(id);
    expect(detail.addressHistory).toEqual([]);
    expect(detail.addressEditable.editable).toBe(false);
    expect(detail.addressEditable.reason).toMatch(/AWB/);
  });
});

// The Bill of Supply is built fresh from the order on every download, so it shows
// an edited address by itself. These tests prove that, and that nothing else on the
// bill moves (number, date and amount stay).
const hasPdftotext = spawnSync("pdftotext", ["-v"]).status !== null;

function billText(pdf: Uint8Array): string {
  const dir = mkdtempSync(path.join(tmpdir(), "addr-bill-"));
  try {
    const file = path.join(dir, "bill.pdf");
    writeFileSync(file, pdf);
    const out = spawnSync("pdftotext", ["-layout", file, "-"], {
      encoding: "utf8",
    });
    if (out.status !== 0) throw new Error(`pdftotext failed: ${out.stderr}`);
    return out.stdout.replace(/\s+/g, " ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasPdftotext)(
  "the Bill of Supply after an address change",
  () => {
    it("shows the new address and place of supply, and keeps number, date and amount", async () => {
      const id = await makeOrder({ status: "PAID" });
      const billNumber = `BOS-99-${RUN}`;
      await prisma.order.update({
        where: { id },
        data: {
          billNumber,
          billIssuedAt: new Date("2026-11-16T10:00:00.000Z"),
          billBookTitle: "Test Book",
        },
      });

      const before = billText((await buildBillOfSupplyPdf(id)).bytes);
      expect(before).toContain("Old Name");
      expect(before).toContain("1 Old Street");
      expect(before).toContain("Maharashtra");

      await editOrderAddress(id, { ...NEW_INPUT, state: "Karnataka" }, ADMIN);

      const afterBill = await buildBillOfSupplyPdf(id);
      const after = billText(afterBill.bytes);
      expect(after).toContain("New Name");
      expect(after).toContain("2 New Road");
      expect(after).toContain("Pune");
      expect(after).toContain("411001");
      expect(after).toContain("9123456780");
      expect(after).not.toContain("9999999999");
      expect(after).toContain("Karnataka"); // Place of Supply follows the state
      expect(after).not.toContain("Old Name");
      expect(after).not.toContain("1 Old Street");
      expect(afterBill.fileName).toBe(`${billNumber}.pdf`);
      expect(after).toContain(billNumber);
      expect(after).toContain("999.00"); // the amount did not move
      expect(after).toContain("16/11/2026"); // the issue date did not move
    });
  }
);

describe("a save on top of a newer change, and nothing-to-save with an open change", () => {
  it("a form based on an older change is refused, and nothing is saved", async () => {
    const id = await makeOrder({ status: "PAID" });
    const first = await editOrderAddress(id, NEW_INPUT, ADMIN);
    if (!first.changed) throw new Error("setup");
    // Another admin opened the form before that change (expectedSeq 0) and saves now.
    const error = await refusal(
      editOrderAddress(
        id,
        { ...NEW_INPUT, line1: "9 Stale Street", expectedSeq: 0 },
        OTHER_ADMIN
      )
    );
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/changed by someone else/);
    expect((await readOrder(id)).shippingLine1).toBe("2 New Road");
    expect(await rows(id)).toHaveLength(1);
    // Reloaded and based on the newest change, the same save goes through.
    const ok = await editOrderAddress(
      id,
      { ...NEW_INPUT, line1: "9 Stale Street", expectedSeq: first.seq },
      OTHER_ADMIN
    );
    expect(ok.changed).toBe(true);
  });

  it("saving the address as it already is says so, and says when an earlier change still waits for Shiprocket", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    getOrderAddress.mockResolvedValue(HELD_OLD);
    updateOrderAddress.mockRejectedValue(new Error("down"));
    await editOrderAddress(id, NEW_INPUT, ADMIN); // FAILED, but the order holds the new address
    const again = await editOrderAddress(id, NEW_INPUT, ADMIN);
    expect(again).toEqual({ changed: false, unsynced: true });

    const calm = await makeOrder({ status: "PAID" });
    expect(
      await editOrderAddress(calm, { ...OLD_INPUT, phone: OLD.phone }, ADMIN)
    ).toEqual({
      changed: false,
      unsynced: false,
    });
  });
});

describe("the AWB appears between the edit's read and its write", () => {
  // Phase B writes only awbNumber and leaves the status at READY_TO_SHIP, so the status
  // guard alone cannot catch it: the awbNumber clause of the write must.
  it("the edit is refused and saves nothing", async () => {
    const id = await makeOrder({
      status: "READY_TO_SHIP",
      shiprocketOrderId: "555",
    });
    const restore = moveStatusAfterRead(id, 1, () =>
      prisma.order.update({ where: { id }, data: { awbNumber: "AWB-RACE-1" } })
    );
    let error: AppError | null = null;
    try {
      error = await refusal(editOrderAddress(id, NEW_INPUT, ADMIN));
    } finally {
      restore();
    }
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/AWB/);
    expect(await rows(id)).toHaveLength(0);
    expect((await readOrder(id)).shippingName).toBe("Old Name");
  });
});

// These two stub prisma.$transaction (to move the order's status after the edit's first
// read, which a test cannot time otherwise), so they stay LAST in the file and always
// restore it (LESSONS L-018). The database itself is real.
function moveStatusAfterRead(
  orderId: string,
  flips: number,
  mutate?: () => Promise<unknown>
) {
  const originalFn = prisma.$transaction;
  const original = originalFn.bind(prisma) as (
    ...a: unknown[]
  ) => Promise<unknown>;
  let done = 0;
  (prisma as unknown as Record<string, unknown>).$transaction = ((
    fn: unknown,
    opts: unknown
  ) => {
    if (typeof fn !== "function") return original(fn, opts);
    return original(async (tx: Record<string, unknown>) => {
      const order = tx.order as Record<string, (...a: unknown[]) => unknown>;
      const proxyOrder = new Proxy(order, {
        get(target, prop) {
          const value = target[prop as string];
          if (prop !== "findUnique")
            return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => unknown).apply(
              target,
              args
            );
            if (done < flips && mutate) {
              done++;
              await mutate();
            } else if (done < flips) {
              done++;
              const now = (
                await prisma.order.findUniqueOrThrow({
                  where: { id: orderId },
                  select: { status: true },
                })
              ).status;
              await prisma.order.update({
                where: { id: orderId },
                data: {
                  status: now === "GENERATED" ? "CONFIRMED" : "GENERATED",
                },
              });
            }
            return result;
          };
        },
      });
      const proxyTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === "order") return proxyOrder;
          const value = target[prop as string];
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      return (fn as (t: unknown) => unknown)(proxyTx);
    }, opts);
  }) as never;
  // vitest's own restore leaves the Prisma client without $transaction, so put it
  // back by hand.
  return () => {
    (prisma as unknown as Record<string, unknown>).$transaction = originalFn;
  };
}

describe("the status moves between the edit's read and its write", () => {
  it("once: the edit re-reads, and the change is PENDING because the order is now CONFIRMED", async () => {
    const id = await makeOrder({ status: "GENERATED" });
    const restore = moveStatusAfterRead(id, 1);
    try {
      const result = await editOrderAddress(id, NEW_INPUT, ADMIN);
      expect(result.changed).toBe(true);
    } finally {
      restore();
    }
    const history = await rows(id);
    expect(history).toHaveLength(1);
    expect(history[0]!.syncStatus).toBe("PENDING"); // never NOT_REQUIRED on a CONFIRMED order
    expect((await readOrder(id)).status).toBe("CONFIRMED");
    expect((await readOrder(id)).shippingName).toBe("New Name");
  });

  it("twice: the edit gives up with a 409 and saves nothing", async () => {
    const id = await makeOrder({ status: "GENERATED" });
    const restore = moveStatusAfterRead(id, 2);
    let error: AppError | null = null;
    try {
      error = await refusal(editOrderAddress(id, NEW_INPUT, ADMIN));
    } finally {
      restore();
    }
    expect(error?.statusCode).toBe(409);
    expect(error?.message).toMatch(/changed while/);
    expect(await rows(id)).toHaveLength(0);
    expect((await readOrder(id)).shippingName).toBe("Old Name");
  });
});
