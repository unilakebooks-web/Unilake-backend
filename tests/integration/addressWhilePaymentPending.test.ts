// Integration tests for changing the delivery address of an order whose payment was started but not
// finished (BUG-027). They run against the Neon TEST branch only: the setup import below refuses any other database.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { updateOrderSession } from "../../src/services/session.service.js";
import { ConflictError } from "../../src/utils/errors.js";

const MARK = "__vitest_addrpending__";
const RUN = Math.random().toString(36).slice(2, 8);
const COMIC_ID = "00000000-0000-4000-8000-000000000100";
const userIds: string[] = [];
let n = 0;

const newAddress = {
  shippingName: "New Name",
  shippingLine1: "22 New Road",
  shippingLine2: "",
  shippingCity: "Pune",
  shippingState: "Maharashtra",
  shippingZip: "411001",
  shippingCountry: "IN",
  shippingPhone: "8888888888",
};

async function make(
  over: {
    sessionStatus?: "PREVIEW_READY" | "AWAITING_PAYMENT" | "PAID";
    orderStatus?: "CREATED" | "PAID" | null;
    country?: string;
    isSample?: boolean;
  } = {}
) {
  const id = `${MARK}-${RUN}-${++n}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  userIds.push(id);
  const country = over.country ?? "IN";
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId: id,
      isSample: over.isSample ?? false,
      status: over.sessionStatus ?? "AWAITING_PAYMENT",
      coverType: "HARDCOVER",
      childName: "Kid",
      shippingName: "Old Name",
      shippingLine1: "1 Old St",
      shippingLine2: "Flat 4",
      shippingCity: "Mumbai",
      shippingState: "Maharashtra",
      shippingZip: "400001",
      shippingCountry: country,
      shippingPhone: "9999999999",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const orderStatus =
    over.orderStatus === undefined ? "CREATED" : over.orderStatus;
  const order =
    orderStatus === null
      ? null
      : await prisma.order.create({
          data: {
            orderSessionId: session.id,
            amount: 999,
            currency: country === "IN" ? "INR" : "USD",
            countryCode: country,
            coverType: "HARDCOVER",
            razorpayOrderId: `order_${MARK}_${RUN}_${n}`,
            status: orderStatus,
            shippingName: "Old Name",
            shippingLine1: "1 Old St",
            shippingLine2: "Flat 4",
            shippingCity: "Mumbai",
            shippingState: "Maharashtra",
            shippingZip: "400001",
            shippingCountry: country,
            shippingPhone: "9999999999",
          },
        });
  return { sessionId: session.id, orderId: order?.id ?? null };
}

const rows = async (sessionId: string) => ({
  session: await prisma.orderSession.findUniqueOrThrow({
    where: { id: sessionId },
  }),
  order: await prisma.order.findUnique({
    where: { orderSessionId: sessionId },
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

/** Runs `hook` right after the next read of an Order, so a test can change the database between the service's read and its write. */
async function withChangeAfterOrderRead<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>
) {
  const delegate = prisma.order as unknown as {
    findUnique: (...a: unknown[]) => Promise<unknown>;
  };
  const real = delegate.findUnique;
  delegate.findUnique = async (...args: unknown[]) => {
    delegate.findUnique = real; // once only
    const found = await real.apply(delegate, args);
    await hook();
    return found;
  };
  try {
    return await run();
  } finally {
    delegate.findUnique = real;
  }
}

describe("changing the delivery address after payment was started but not finished", () => {
  it("changes the session and the Order together, and leaves the price and Razorpay order alone", async () => {
    const { sessionId } = await make();
    const before = (await rows(sessionId)).order!;
    await updateOrderSession(sessionId, newAddress);
    const { session, order } = await rows(sessionId);
    for (const r of [session, order!]) {
      expect(r.shippingName).toBe("New Name");
      expect(r.shippingLine1).toBe("22 New Road");
      expect(r.shippingCity).toBe("Pune");
      expect(r.shippingZip).toBe("411001");
      expect(r.shippingPhone).toBe("8888888888");
    }
    // An empty line 2 replaces the old one (the old value must not stay on the label).
    expect(session.shippingLine2).toBe("");
    expect(order!.shippingLine2).toBe("");
    expect(order!.razorpayOrderId).toBe(before.razorpayOrderId);
    expect(order!.amount.toString()).toBe(before.amount.toString());
    expect(order!.currency).toBe("INR");
    expect(order!.status).toBe("CREATED");
    expect(session.status).toBe("AWAITING_PAYMENT");
  });

  it("accepts the country in lower case when it is the order's country", async () => {
    const { sessionId } = await make();
    await updateOrderSession(sessionId, {
      ...newAddress,
      shippingCountry: "in",
    });
    const { session, order } = await rows(sessionId);
    expect(session.shippingCountry).toBe("IN");
    expect(order!.shippingCountry).toBe("IN");
  });

  it("refuses another country and changes nothing", async () => {
    const { sessionId } = await make();
    await expect(
      updateOrderSession(sessionId, { ...newAddress, shippingCountry: "US" })
    ).rejects.toThrow(/country cannot change/);
    const { session, order } = await rows(sessionId);
    expect(session.shippingLine1).toBe("1 Old St");
    expect(order!.shippingLine1).toBe("1 Old St");
  });

  it("works for an order outside India (its own country)", async () => {
    const { sessionId } = await make({ country: "US" });
    await updateOrderSession(sessionId, {
      ...newAddress,
      shippingCountry: "US",
      shippingZip: "10001",
    });
    const { order } = await rows(sessionId);
    expect(order!.shippingZip).toBe("10001");
    expect(order!.currency).toBe("USD");
  });

  it.each(["childName", "age", "pronounKey", "coverType"] as const)(
    "still refuses %s together with an address",
    async (field) => {
      const { sessionId } = await make();
      const value = {
        childName: "Other",
        age: 7,
        pronounKey: "HE",
        coverType: "SOFTCOVER",
      }[field];
      await expect(
        updateOrderSession(sessionId, {
          ...newAddress,
          [field]: value,
        } as never)
      ).rejects.toThrow(/locked at checkout/);
      expect((await rows(sessionId)).order!.shippingLine1).toBe("1 Old St");
    }
  );

  it("an address and a notification email together change both on the session", async () => {
    const { sessionId } = await make();
    await updateOrderSession(sessionId, {
      ...newAddress,
      notificationEmail: "new@example.test",
    });
    const { session, order } = await rows(sessionId);
    expect(session.notificationEmail).toBe("new@example.test");
    expect(order!.shippingLine1).toBe("22 New Road");
  });

  it("is refused once the order is paid, with the clear message, and nothing changes", async () => {
    const { sessionId } = await make({ orderStatus: "PAID" });
    await expect(updateOrderSession(sessionId, newAddress)).rejects.toThrow(
      /already gone through/
    );
    expect((await rows(sessionId)).order!.shippingLine1).toBe("1 Old St");
  });

  it("is refused when the payment lands between the read and the write", async () => {
    const { sessionId, orderId } = await make();
    await expect(
      withChangeAfterOrderRead(
        async () => {
          await prisma.order.update({
            where: { id: orderId! },
            data: { status: "PAID" },
          });
        },
        () => updateOrderSession(sessionId, newAddress)
      )
    ).rejects.toThrow(/already gone through/);
    const { session, order } = await rows(sessionId);
    expect(order!.shippingLine1).toBe("1 Old St");
    expect(session.shippingLine1).toBe("1 Old St");
  });

  it("rolls the Order change back when the session moved on between the read and the write", async () => {
    const { sessionId } = await make();
    await expect(
      withChangeAfterOrderRead(
        async () => {
          await prisma.orderSession.update({
            where: { id: sessionId },
            data: { status: "PAID" },
          });
        },
        () => updateOrderSession(sessionId, newAddress)
      )
    ).rejects.toBeInstanceOf(ConflictError);
    const { order } = await rows(sessionId);
    expect(order!.shippingLine1).toBe("1 Old St"); // the Order change was rolled back
  });

  it("an AWAITING_PAYMENT session without an order stays locked", async () => {
    const { sessionId } = await make({ orderStatus: null });
    await expect(updateOrderSession(sessionId, newAddress)).rejects.toThrow(
      /locked at checkout/
    );
  });

  it("refuses a cancelled order with its own message", async () => {
    const { sessionId, orderId } = await make();
    await prisma.order.update({
      where: { id: orderId! },
      data: { status: "CANCELLED" },
    });
    await expect(updateOrderSession(sessionId, newAddress)).rejects.toThrow(
      /was cancelled/
    );
    expect((await rows(sessionId)).order!.shippingLine1).toBe("1 Old St");
  });

  it("refuses a lower-case country that is not the order's, and accepts a change of one field only", async () => {
    const { sessionId } = await make();
    await expect(
      updateOrderSession(sessionId, { ...newAddress, shippingCountry: "us" })
    ).rejects.toThrow(/country cannot change/);
    await updateOrderSession(sessionId, { shippingLine1: "9 Only Line One" });
    const { session, order } = await rows(sessionId);
    expect(session.shippingLine1).toBe("9 Only Line One");
    expect(order!.shippingLine1).toBe("9 Only Line One");
    expect(order!.shippingCity).toBe("Mumbai"); // the other fields stay as they were
  });

  it("a paid session stays locked as before", async () => {
    const { sessionId } = await make({
      sessionStatus: "PAID",
      orderStatus: "PAID",
    });
    await expect(updateOrderSession(sessionId, newAddress)).rejects.toThrow(
      /locked at checkout/
    );
  });

  it("a session still in preview changes its own address only, as before", async () => {
    const { sessionId } = await make({
      sessionStatus: "PREVIEW_READY",
      orderStatus: null,
    });
    await updateOrderSession(sessionId, newAddress);
    expect((await rows(sessionId)).session.shippingLine1).toBe("22 New Road");
  });

  it("a notification email alone is still editable while payment is pending (and the order's address is untouched)", async () => {
    const { sessionId } = await make();
    await updateOrderSession(sessionId, {
      notificationEmail: "only@example.test",
    });
    const { session, order } = await rows(sessionId);
    expect(session.notificationEmail).toBe("only@example.test");
    expect(order!.shippingLine1).toBe("1 Old St");
  });

  it("an admin sample is still refused", async () => {
    const { sessionId } = await make({
      sessionStatus: "PREVIEW_READY",
      orderStatus: null,
      isSample: true,
    });
    await expect(updateOrderSession(sessionId, newAddress)).rejects.toThrow(
      /admin sample/
    );
  });
});
