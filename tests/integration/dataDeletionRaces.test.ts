// Race and interleave tests for automatic data deletion (feature 6): the places where the deletion claim, the payment
// webhook, checkout and a coupon change meet on the same rows. Every test holds one side open (a locked transaction,
// a Razorpay call that has not answered, a storage call) while the other side runs, so the order of events is fixed
// by the test, not by timing luck. Neon TEST branch and local MinIO only; Redis queues and Razorpay are stubs.
// The claim is driven through processCandidate with an injected clock; the test database is shared, so every row
// and object here carries this file's own prefix or ids and is removed again.
import "../setup/env.js";
import { createHmac } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { addBulk, rzpCreate, notify } = vi.hoisted(() => ({
  addBulk: vi.fn(async () => []),
  rzpCreate: vi.fn(),
  notify: {
    received: vi.fn(async () => ({ sent: true })),
    afterDeletion: vi.fn(async () => ({ sent: true })),
  },
}));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk, getJob: vi.fn(async () => null) },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/razorpay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/razorpay.js")>()),
  razorpay: { orders: { create: rzpCreate } },
}));
vi.mock(
  "../../src/services/notification.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/services/notification.service.js")
    >()),
    notifyPaymentReceived: notify.received,
    notifyPaidAfterDeletion: notify.afterDeletion,
  })
);

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import { redisClient } from "../../src/lib/redis.js";
import { deletePrefix, r2Client, uploadFile } from "../../src/lib/r2.js";
import {
  createRunContext,
  processCandidate,
  type DeletionDeps,
} from "../../src/services/dataDeletionEngine.service.js";
import type { DeletionCandidate } from "../../src/services/dataDeletionSelect.service.js";
import { handleRazorpayWebhook } from "../../src/services/webhook.service.js";
import { initiateCheckout } from "../../src/services/checkout.service.js";
import {
  priceCoupon,
  repriceUnpaidOrder,
} from "../../src/services/couponCheckout.service.js";
import { createCoupon } from "../../src/services/coupon.service.js";
import { createCouponSchema } from "../../src/validators/coupon.schema.js";

const MARK = "__vitest_deletion_races__";
const RUN = Math.random().toString(36).slice(2, 8);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
// The deletion clock far in the future: every session below is due by it. Checkout and the webhook use the real
// clock, so the sessions' own expiry is real-future where checkout needs it.
const FAR = new Date("2031-06-15T12:00:00.000Z");
const ago = (ms: number) => new Date(FAR.getTime() - ms);
// Seeded by the seed script (the coupon checkout tests rely on the same ids): INR hardcover price 999.
const COMIC_ID = "00000000-0000-4000-8000-000000000100";

const rzp = {
  fetchPayments: vi.fn(
    async (_id: string): Promise<unknown> => ({
      entity: "collection",
      count: 0,
      items: [],
    })
  ),
  fetchOrder: vi.fn(
    async (_id: string): Promise<unknown> => ({ status: "created" })
  ),
};
const deps = (now: () => Date = () => FAR): DeletionDeps => ({ now, rzp });
const newCtx = (d: DeletionDeps) =>
  createRunContext(d, d.now().getTime() + DAY, 20);

let userId: string;
const sessionIds: string[] = [];

interface Made {
  id: string;
  orderId: string | null;
  razorpayOrderId: string | null;
}

async function mk(opts: {
  status?: "PREVIEW_READY" | "AWAITING_PAYMENT" | "PAID";
  expiresAt: Date;
  order?: {
    status?: "CREATED" | "PAID" | "DELIVERED";
    currency?: "INR" | "USD";
    couponCode?: string;
    updatedAt?: Date;
    createdAt?: Date;
    deliveredAt?: Date;
    pdfUrl?: string;
  };
}): Promise<Made> {
  const session = await prisma.orderSession.create({
    data: {
      comicId: COMIC_ID,
      userId,
      status: opts.status ?? "PREVIEW_READY",
      expiresAt: opts.expiresAt,
      rawPhotoUrls: [],
      coverType: "HARDCOVER",
      childName: "Aarav",
      shippingName: `${MARK} ${RUN}`,
      shippingLine1: "1 Test St",
      shippingCity: "Mumbai",
      shippingState: "Maharashtra",
      shippingZip: "400001",
      shippingCountry: "IN",
      shippingPhone: "9999999999",
    },
  });
  sessionIds.push(session.id);
  let orderId: string | null = null;
  let razorpayOrderId: string | null = null;
  if (opts.order) {
    razorpayOrderId = `order_${RUN}_${session.id.slice(0, 8)}`;
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: opts.order.currency === "USD" ? "12.00" : "999.00",
        currency: opts.order.currency ?? "INR",
        countryCode: opts.order.currency === "USD" ? "US" : "IN",
        coverType: "HARDCOVER",
        status: opts.order.status ?? "CREATED",
        razorpayOrderId,
        couponCode: opts.order.couponCode ?? null,
        pdfUrl: opts.order.pdfUrl ?? null,
        deliveredAt: opts.order.deliveredAt ?? null,
        shippingName: `${MARK} ${RUN}`,
        notificationEmail: `races-${RUN}@example.test`,
      },
    });
    orderId = order.id;
    if (opts.order.updatedAt || opts.order.createdAt) {
      await prisma.$executeRaw`UPDATE "orders" SET "updatedAt" = ${opts.order.updatedAt ?? ago(3 * DAY)}, "createdAt" = ${opts.order.createdAt ?? ago(400 * DAY)} WHERE "id" = ${order.id}`;
    }
  }
  return { id: session.id, orderId, razorpayOrderId };
}

const candidate = (
  s: Made,
  scope: DeletionCandidate["scope"] = "SESSION"
): DeletionCandidate => ({
  group: scope === "SESSION" ? "PREVIEWS" : "BOOKS",
  scope,
  subjectType: scope === "PDF" ? "ORDER" : "SESSION",
  subjectId: scope === "PDF" ? (s.orderId as string) : s.id,
  sessionId: s.id,
  orderId: s.orderId,
  dueAt: FAR,
});

const markers = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true, status: true },
  });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until some database session is blocked on a lock while running a statement that contains `fragment`. */
async function waitForLockWaiter(fragment: string, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND query LIKE ${"%" + fragment + "%"}`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await sleep(250);
  }
  const waiting = await prisma.$queryRaw<{ query: string }[]>`
    SELECT left(query, 160) AS query FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
  throw new Error(
    `nothing is waiting for a lock on: ${fragment}; waiting now: ${JSON.stringify(waiting)}`
  );
}

/**
 * Runs `body` inside an open transaction and keeps the transaction open until `release()` is called, which commits it.
 * `started` resolves once the body has run to its end.
 */
function holdTransaction(
  body: (tx: Prisma.TransactionClient) => Promise<void>
) {
  const started = deferred();
  const gate = deferred();
  const done = prisma
    .$transaction(
      async (tx) => {
        await body(tx);
        started.resolve();
        await gate.promise;
      },
      { maxWait: 30_000, timeout: 180_000 }
    )
    .catch((error) => {
      started.resolve();
      throw error;
    });
  openHolds.push({ gate: gate.resolve, done });
  return {
    started: started.promise,
    release: async () => {
      gate.resolve();
      await done;
    },
  };
}

// A test that fails while it holds a transaction must not leave it open (the cleanup would wait on its locks).
const openHolds: { gate: () => void; done: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const hold of openHolds.splice(0)) {
    hold.gate();
    await Promise.allSettled([hold.done]);
  }
});

/** The deletion claim's own locks and marker write, kept open: order row, then session row, then the markers. */
const heldClaim = (sessionId: string, at: Date) =>
  holdTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "orderSessionId" = ${sessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "order_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
    await tx.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${at}, "filesDeletedAt" = ${at} WHERE "id" = ${sessionId}`;
  });

/** Runs `body` with the storage client's send replaced (restored afterwards). */
async function withStorage(
  wrap: (
    cmd: unknown,
    original: (c: unknown, o: unknown) => Promise<unknown>,
    opts: unknown
  ) => Promise<unknown>,
  body: () => Promise<void>
) {
  const original = r2Client.send.bind(r2Client) as (
    c: unknown,
    o: unknown
  ) => Promise<unknown>;
  (r2Client as { send: unknown }).send = async (cmd: unknown, opts: unknown) =>
    wrap(cmd, original, opts);
  try {
    await body();
  } finally {
    (r2Client as { send: unknown }).send = original;
  }
}

/** Runs `body` with the database transaction wrapper set to run `before(tx)` first inside every transaction. */
async function withTransactionPrelude(
  before: (tx: Prisma.TransactionClient) => Promise<void>,
  body: () => Promise<void>
) {
  const client = prisma as unknown as {
    $transaction: (...args: unknown[]) => Promise<unknown>;
  };
  const real = client.$transaction.bind(prisma);
  client.$transaction = (...args: unknown[]) => {
    const [callback, ...rest] = args;
    if (typeof callback !== "function") return real(...args);
    return real(
      async (tx: Prisma.TransactionClient) => {
        await before(tx);
        return (callback as (t: Prisma.TransactionClient) => unknown)(tx);
      },
      ...rest
    );
  };
  try {
    await body();
  } finally {
    client.$transaction = real;
  }
}

function signedCapture(razorpayOrderId: string, tag: string) {
  const eventId = `evt_${MARK}_${RUN}_${tag}`;
  const body = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_${RUN}_${tag}`,
          order_id: razorpayOrderId,
          amount: 99900,
          currency: "INR",
          status: "captured",
        },
      },
    },
  });
  const signature = createHmac("sha256", config.razorpay.razorpayWebhookSecret)
    .update(body)
    .digest("hex");
  return { body: Buffer.from(body), signature, eventId };
}

async function cleanup() {
  const known = await prisma.orderSession.findMany({
    where: { userId: { startsWith: MARK } },
    select: { id: true },
  });
  const ids = [...new Set([...sessionIds, ...known.map((s) => s.id)])];
  const orders = await prisma.order.findMany({
    where: { orderSessionId: { in: ids } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.webhookEvent.deleteMany({
    where: {
      OR: [
        { orderId: { in: orderIds } },
        { eventId: { startsWith: `evt_${MARK}` } },
        { eventId: { startsWith: `${MARK}-` } },
      ],
    },
  });
  await prisma.couponRedemption.deleteMany({
    where: {
      OR: [{ orderId: { in: orderIds } }, { userId: { startsWith: MARK } }],
    },
  });
  await prisma.deletionItem.deleteMany({
    where: { subjectId: { in: [...ids, ...orderIds] } },
  });
  await prisma.deletionBlock.deleteMany({
    where: { subjectId: { in: [...ids, ...orderIds] } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
  await prisma.coupon.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
  for (const id of ids) {
    await deletePrefix("public", `sessions/${id}/`);
    await deletePrefix("private", `sessions/${id}/`);
  }
  await redisClient.del(`coupon:failed-attempts:${userId}`);
  sessionIds.length = 0;
}

beforeAll(async () => {
  userId = `${MARK}-${RUN}-user`;
  await cleanup();
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  const rule = await prisma.pricingRule.findFirst({
    where: {
      comicId: COMIC_ID,
      coverType: "HARDCOVER",
      country: { code: "IN" },
    },
  });
  if (!rule || !rule.price.equals(999)) {
    throw new Error(
      "The test database needs the seeded comic with an INR hardcover price of 999 (run the seed script)."
    );
  }
});

beforeEach(() => {
  addBulk.mockClear();
  rzpCreate.mockReset();
  notify.received.mockClear();
  notify.afterDeletion.mockClear();
  rzp.fetchPayments.mockClear();
});

afterAll(async () => {
  await cleanup();
  await redisClient.quit();
  await prisma.$disconnect();
});

// Every test here waits on database round trips (about 350 ms each) several dozen times.
const LONG = 150_000;

// ---------------------------------------------------------------------------------------------
// H3: the marker time under a database session in another time zone
// ---------------------------------------------------------------------------------------------
describe("the claim's marker time under a database session in Asia/Kolkata", () => {
  it(
    "every marker kind (session, photo, pages, pdf) stores the injected UTC clock, not the session's local time",
    async () => {
      const unpaid = await mk({ expiresAt: ago(10 * DAY) });
      const delivered = await mk({
        status: "PAID",
        expiresAt: ago(100 * DAY),
        order: {
          status: "DELIVERED",
          deliveredAt: ago(60 * DAY),
          createdAt: ago(100 * DAY),
          updatedAt: ago(60 * DAY),
        },
      });
      await prisma.order.update({
        where: { id: delivered.orderId as string },
        data: { pdfUrl: `pdfs/${delivered.id}.pdf` },
      });
      await uploadFile(
        "public",
        `pdfs/${delivered.id}.pdf`,
        Buffer.from("%PDF"),
        "application/pdf"
      );
      const stamps = async () => ({
        unpaid: (
          await prisma.orderSession.findUniqueOrThrow({
            where: { id: unpaid.id },
          })
        ).updatedAt.getTime(),
        delivered: (
          await prisma.orderSession.findUniqueOrThrow({
            where: { id: delivered.id },
          })
        ).updatedAt.getTime(),
        order: (
          await prisma.order.findUniqueOrThrow({
            where: { id: delivered.orderId as string },
          })
        ).updatedAt.getTime(),
      });
      const before = await stamps();
      const zones: string[] = [];
      await withTransactionPrelude(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
          const [row] = await tx.$queryRaw<
            { TimeZone: string }[]
          >`SHOW TIME ZONE`;
          zones.push(row?.TimeZone as string);
        },
        async () => {
          const d = deps();
          const ctx = newCtx(d);
          expect(await processCandidate(ctx, candidate(unpaid))).toMatchObject({
            kind: "done",
          });
          for (const scope of ["PHOTO", "PAGES", "PDF"] as const) {
            const out = await processCandidate(
              newCtx(d),
              candidate(delivered, scope)
            );
            expect([scope, out.kind]).toEqual([scope, "done"]);
          }
        }
      );
      // the claim really ran in that zone (once per claim transaction)
      expect(zones.length).toBeGreaterThanOrEqual(4);
      expect(new Set(zones)).toEqual(new Set(["Asia/Kolkata"]));
      const a = await markers(unpaid.id);
      expect(a.photoDeletedAt?.toISOString()).toBe(FAR.toISOString());
      expect(a.filesDeletedAt?.toISOString()).toBe(FAR.toISOString());
      const b = await markers(delivered.id);
      expect(b.photoDeletedAt?.toISOString()).toBe(FAR.toISOString());
      expect(b.filesDeletedAt?.toISOString()).toBe(FAR.toISOString());
      const pdf = await prisma.order.findUniqueOrThrow({
        where: { id: delivered.orderId as string },
        select: { pdfDeletedAt: true },
      });
      expect(pdf.pdfDeletedAt?.toISOString()).toBe(FAR.toISOString());
      // a marker write never moves updatedAt (the admin list order and reminder A's quiet guard read it)
      expect(await stamps()).toEqual(before);
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// H4: the payment webhook against a claim that is still holding its locks
// ---------------------------------------------------------------------------------------------
describe("payment webhook interleaved with a claim", () => {
  it(
    "a claim that takes its locks after the webhook has read the order and before its transaction, and commits while the flip waits, is seen: flagged, one plain mail, no generation",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: { status: "CREATED" },
      });
      const client = prisma as unknown as {
        $transaction: (...args: unknown[]) => Promise<unknown>;
      };
      const real = client.$transaction.bind(prisma);
      let claim: ReturnType<typeof heldClaim> | undefined;
      client.$transaction = async (...args: unknown[]) => {
        // The webhook has read the unmarked session and is about to open its transaction: the claim gets in first
        // (order row, session row, markers) and stays open, so the webhook's guarded flip has to wait for it.
        client.$transaction = real;
        claim = heldClaim(s.id, new Date());
        await claim.started;
        return real(...args);
      };
      try {
        const evt = signedCapture(s.razorpayOrderId as string, "held");
        let settled = false;
        const webhook = handleRazorpayWebhook(
          evt.body,
          evt.signature,
          evt.eventId
        ).finally(() => (settled = true));
        await waitForLockWaiter('UPDATE "public"."orders"');
        expect(claim).toBeDefined();
        expect(settled).toBe(false);
        expect(
          (
            await prisma.order.findUniqueOrThrow({
              where: { id: s.orderId as string },
            })
          ).status
        ).toBe("CREATED");
        await (claim as ReturnType<typeof heldClaim>).release();
        await webhook;
      } finally {
        client.$transaction = real;
      }
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: s.orderId as string },
      });
      expect(order.status).toBe("PAID");
      expect(order.paidAfterDeletionAt).not.toBeNull();
      expect(addBulk).not.toHaveBeenCalled();
      expect(notify.received).not.toHaveBeenCalled();
      expect(notify.afterDeletion).toHaveBeenCalledTimes(1);
      expect((await markers(s.id)).status).toBe("PAID");
    },
    LONG
  );

  it(
    "a claim that already holds the order row when the webhook starts makes it wait at its first write to the order's event; after the commit it sees the marker",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: { status: "CREATED" },
      });
      const claim = heldClaim(s.id, new Date());
      await claim.started;
      const evt = signedCapture(s.razorpayOrderId as string, "held-early");
      let settled = false;
      const webhook = handleRazorpayWebhook(
        evt.body,
        evt.signature,
        evt.eventId
      ).finally(() => (settled = true));
      // FOR UPDATE on the order row also blocks the key-share lock of the event row's order reference.
      await waitForLockWaiter('UPDATE "public"."webhook_events"');
      expect(settled).toBe(false);
      await claim.release();
      await webhook;
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: s.orderId as string },
      });
      expect(order.status).toBe("PAID");
      expect(order.paidAfterDeletionAt).not.toBeNull();
      expect(addBulk).not.toHaveBeenCalled();
      expect(notify.afterDeletion).toHaveBeenCalledTimes(1);
    },
    LONG
  );

  it(
    "the other order: a payment that flipped the order (lock held) makes a claim that started meanwhile refuse, and nothing is marked",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: { status: "CREATED", updatedAt: ago(3 * DAY) },
      });
      // The webhook's first write: the guarded order flip. Its transaction is still open (the session flip has not run).
      const flip = holdTransaction(async (tx) => {
        await tx.order.updateMany({
          where: { id: s.orderId as string, status: "CREATED" },
          data: { status: "PAID", razorpayPaymentId: `pay_${RUN}_flip` },
        });
      });
      await flip.started;
      let outcome: unknown;
      const claim = processCandidate(newCtx(deps()), candidate(s)).then(
        (o) => (outcome = o)
      );
      await waitForLockWaiter("FOR UPDATE");
      expect(outcome).toBeUndefined();
      await flip.release();
      await claim;
      expect(outcome).toEqual({ kind: "refused", reason: "order_PAID" });
      const m = await markers(s.id);
      expect([m.photoDeletedAt, m.filesDeletedAt]).toEqual([null, null]);
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// H5: the claim against checkout and a coupon change
// ---------------------------------------------------------------------------------------------
describe("claim against checkout and coupon changes", () => {
  it(
    "a claim that commits while the Razorpay order is being created makes checkout roll back: PREVIEW_DELETED, no order row",
    async () => {
      const s = await mk({ expiresAt: new Date(Date.now() + DAY) });
      const barrier = deferred();
      const called = deferred();
      rzpCreate.mockImplementation(async () => {
        called.resolve();
        await barrier.promise;
        return { id: `order_${RUN}_checkout` };
      });
      const checkout = initiateCheckout(s.id, {}).then(
        () => "resolved",
        (error) => error
      );
      await called.promise;
      const outcome = await processCandidate(newCtx(deps()), candidate(s));
      expect(outcome).toMatchObject({ kind: "done" });
      barrier.resolve();
      const result = await checkout;
      expect(result).toMatchObject({ code: "PREVIEW_DELETED" });
      expect(
        await prisma.order.count({ where: { orderSessionId: s.id } })
      ).toBe(0);
      const m = await markers(s.id);
      expect(m.status).toBe("PREVIEW_READY");
      expect(m.filesDeletedAt).not.toBeNull();
    },
    LONG
  );

  it(
    "removing a coupon: a claim that commits while the new Razorpay order is being made rolls the change back, the order keeps its code and Razorpay id",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: {
          status: "CREATED",
          couponCode: "VTR-ANY",
          updatedAt: ago(3 * DAY),
        },
      });
      const barrier = deferred();
      const called = deferred();
      rzpCreate.mockImplementation(async () => {
        called.resolve();
        await barrier.promise;
        return { id: `order_${RUN}_swapped` };
      });
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: s.orderId as string },
      });
      const session = await prisma.orderSession.findUniqueOrThrow({
        where: { id: s.id },
      });
      const change = repriceUnpaidOrder({
        order,
        session,
        couponCode: null,
        callerUserId: userId,
      }).then(
        () => "resolved",
        (error) => error
      );
      await called.promise;
      const outcome = await processCandidate(newCtx(deps()), candidate(s));
      expect(outcome).toMatchObject({ kind: "done" });
      barrier.resolve();
      expect(await change).toMatchObject({ code: "PREVIEW_DELETED" });
      const after = await prisma.order.findUniqueOrThrow({
        where: { id: s.orderId as string },
      });
      expect(after.razorpayOrderId).toBe(order.razorpayOrderId);
      expect(after.couponCode).toBe("VTR-ANY");
      expect(after.supersededRazorpayOrderIds).toEqual([]);
    },
    LONG
  );

  it(
    "refreshing a lapsed reservation: a claim that commits while the refresh waits for the order lock rolls it back",
    async () => {
      const coupon = await createCoupon(
        createCouponSchema.parse({
          name: `${MARK} offer`,
          discountType: "PERCENT",
          percentOff: 20,
          code: `VTR-${RUN.toUpperCase()}-R`,
          usageLimit: 5,
        }),
        "vitest-admin"
      );
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + DAY),
        order: { status: "CREATED", updatedAt: ago(3 * DAY) },
      });
      const priced = await priceCoupon({
        userId,
        rawCode: coupon.code,
        comicId: COMIC_ID,
        countryCode: "IN",
        coverType: "HARDCOVER",
        currency: "INR",
        listPrice: new Prisma.Decimal("999.00"),
      });
      await prisma.order.update({
        where: { id: s.orderId as string },
        data: { amount: priced.finalAmount, couponCode: priced.code },
      });
      const lapsedAt = new Date(Date.now() - 3 * HOUR);
      await prisma.couponRedemption.create({
        data: {
          couponId: coupon.id,
          orderId: s.orderId as string,
          userId,
          status: "RESERVED",
          discountAmount: 10,
          createdAt: lapsedAt,
        },
      });
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: s.orderId as string },
      });
      const session = await prisma.orderSession.findUniqueOrThrow({
        where: { id: s.id },
      });
      // The claim's order lock is held, and the markers are written under it.
      const claim = heldClaim(s.id, new Date());
      await claim.started;
      const refresh = repriceUnpaidOrder({
        order,
        session,
        couponCode: coupon.code,
        callerUserId: userId,
      }).then(
        () => "resolved",
        (error) => error
      );
      await waitForLockWaiter("FOR UPDATE");
      await claim.release();
      expect(await refresh).toMatchObject({ code: "PREVIEW_DELETED" });
      const redemption = await prisma.couponRedemption.findUniqueOrThrow({
        where: { orderId: s.orderId as string },
      });
      expect(redemption.createdAt.getTime()).toBe(lapsedAt.getTime());
      expect(rzpCreate).not.toHaveBeenCalled();
    },
    LONG
  );

  it(
    "a claim that starts while checkout's order insert is still uncommitted waits for the session lock, then stands down: nothing is marked",
    async () => {
      // The claim runs with a clock one minute after the real one, so the new order's updatedAt is inside the settle window.
      const nowMs = Date.now();
      const clock = () => new Date(nowMs + 60_000);
      const s = await mk({
        status: "PREVIEW_READY",
        expiresAt: new Date(nowMs - 2 * HOUR),
      });
      // What checkout does in its transaction: insert the order and flip the session, then (not yet) commit.
      const checkoutTx = holdTransaction(async (tx) => {
        await tx.order.create({
          data: {
            orderSessionId: s.id,
            amount: "999.00",
            currency: "INR",
            countryCode: "IN",
            coverType: "HARDCOVER",
            status: "CREATED",
            razorpayOrderId: `order_${RUN}_${s.id.slice(0, 8)}`,
            shippingName: `${MARK} ${RUN}`,
          },
        });
        await tx.orderSession.updateMany({
          where: { id: s.id, status: "PREVIEW_READY" },
          data: { status: "AWAITING_PAYMENT" },
        });
      });
      await checkoutTx.started;
      let outcome: unknown;
      const claim = processCandidate(newCtx(deps(clock)), candidate(s)).then(
        (o) => (outcome = o)
      );
      await waitForLockWaiter("FOR UPDATE");
      expect(outcome).toBeUndefined();
      await checkoutTx.release();
      await claim;
      expect(outcome).toEqual({
        kind: "refused",
        reason: "order_recently_touched",
      });
      const m = await markers(s.id);
      expect([m.photoDeletedAt, m.filesDeletedAt, m.status]).toEqual([
        null,
        null,
        "AWAITING_PAYMENT",
      ]);
      expect(
        await prisma.order.count({ where: { orderSessionId: s.id } })
      ).toBe(1);
    },
    LONG
  );
});

// ---------------------------------------------------------------------------------------------
// H6: the claim's own re-checks, after the item was judged
// ---------------------------------------------------------------------------------------------
describe("the claim re-checks the money inside its lock", () => {
  const settled = () => ({
    status: "CREATED" as const,
    updatedAt: ago(3 * DAY),
  });
  const event = (
    tag: string,
    eventType: string,
    razorpayOrderId: string,
    extra: { orderId?: string; processedAt?: Date } = {}
  ) =>
    prisma.webhookEvent.create({
      data: {
        source: "razorpay",
        eventId: `${MARK}-${RUN}-${tag}`,
        eventType,
        orderId: extra.orderId ?? null,
        ...(extra.processedAt ? { processedAt: extra.processedAt } : {}),
        payloadJson: {
          payload: {
            payment: {
              entity: { order_id: razorpayOrderId, id: `pay_${tag}` },
            },
          },
        },
      },
    });
  const onFirstList = (action: () => Promise<void>) => {
    let done = false;
    return async (
      cmd: unknown,
      original: (c: unknown, o: unknown) => Promise<unknown>,
      opts: unknown
    ) => {
      if (!done && cmd instanceof ListObjectsV2Command) {
        done = true;
        await action();
      }
      return original(cmd, opts);
    };
  };

  it(
    "a payment event stored after the run's scan started and not linked to the order: refused as payment_event_after_scan, nothing marked",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: settled(),
      });
      // The run's scan (empty here) ran before this event arrived.
      await event(
        "after-scan",
        "payment.authorized",
        s.razorpayOrderId as string,
        {
          processedAt: new Date(FAR.getTime() + 1000),
        }
      );
      expect(await processCandidate(newCtx(deps()), candidate(s))).toEqual({
        kind: "refused",
        reason: "payment_event_after_scan",
      });
      const m = await markers(s.id);
      expect([m.photoDeletedAt, m.filesDeletedAt]).toEqual([null, null]);
    },
    LONG
  );

  it(
    "the scan boundary: an event stored at the scan's start counts, one a millisecond before it does not (the scan covered it)",
    async () => {
      const at = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: settled(),
      });
      await event("at-scan", "order.paid", at.razorpayOrderId as string, {
        processedAt: FAR,
      });
      expect(await processCandidate(newCtx(deps()), candidate(at))).toEqual({
        kind: "refused",
        reason: "payment_event_after_scan",
      });
      const before = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: settled(),
      });
      await event(
        "before-scan",
        "order.paid",
        before.razorpayOrderId as string,
        {
          processedAt: new Date(FAR.getTime() - 1),
        }
      );
      expect(
        await processCandidate(newCtx(deps()), candidate(before))
      ).toMatchObject({ kind: "done" });
    },
    LONG
  );

  it(
    "a payment.authorized event linked to the order after it was judged and before the claim: refused as payment_event_linked",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: settled(),
      });
      await withStorage(
        onFirstList(async () => {
          await event(
            "linked-late",
            "payment.authorized",
            s.razorpayOrderId as string,
            {
              orderId: s.orderId as string,
            }
          );
        }),
        async () => {
          expect(await processCandidate(newCtx(deps()), candidate(s))).toEqual({
            kind: "refused",
            reason: "payment_event_linked",
          });
        }
      );
      const m = await markers(s.id);
      expect([m.photoDeletedAt, m.filesDeletedAt]).toEqual([null, null]);
    },
    LONG
  );

  it(
    "a non-INR order (no bill number) with a linked captured event: blocked up front by the guard, and refused by the claim when the event lands later",
    async () => {
      const early = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: { ...settled(), currency: "USD" },
      });
      await event(
        "usd-early",
        "payment.captured",
        early.razorpayOrderId as string,
        {
          orderId: early.orderId as string,
        }
      );
      expect(await processCandidate(newCtx(deps()), candidate(early))).toEqual({
        kind: "blocked",
        reason: "payment_event_linked",
      });

      const late = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: { ...settled(), currency: "USD" },
      });
      const lateOrder = await prisma.order.findUniqueOrThrow({
        where: { id: late.orderId as string },
        select: { billNumber: true, currency: true },
      });
      expect(lateOrder).toEqual({ billNumber: null, currency: "USD" });
      await withStorage(
        onFirstList(async () => {
          await event(
            "usd-late",
            "payment.captured",
            late.razorpayOrderId as string,
            {
              orderId: late.orderId as string,
            }
          );
        }),
        async () => {
          expect(
            await processCandidate(newCtx(deps()), candidate(late))
          ).toEqual({
            kind: "refused",
            reason: "payment_event_linked",
          });
        }
      );
      expect((await markers(late.id)).filesDeletedAt).toBeNull();
    },
    LONG
  );

  it(
    "a payment that flips the order between the judgement and the claim is refused by the claim's own decision (order_PAID)",
    async () => {
      const s = await mk({
        status: "AWAITING_PAYMENT",
        expiresAt: ago(2 * HOUR),
        order: settled(),
      });
      await withStorage(
        onFirstList(async () => {
          await prisma.order.update({
            where: { id: s.orderId as string },
            data: { status: "PAID", razorpayPaymentId: `pay_${RUN}_mid` },
          });
        }),
        async () => {
          expect(await processCandidate(newCtx(deps()), candidate(s))).toEqual({
            kind: "refused",
            reason: "order_PAID",
          });
        }
      );
      expect((await markers(s.id)).filesDeletedAt).toBeNull();
    },
    LONG
  );
});

// marker_not_set is not exercised: the claim's decision (already_marked) reads the same marker under the same session
// lock one statement earlier, so the raw guarded UPDATE cannot match zero rows without a concurrent writer that the
// lock excludes. Recorded in EVIDENCE.md as not reachable.
