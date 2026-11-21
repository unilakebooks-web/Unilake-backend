// Reminder emails (feature 5): who is selected, what is claimed, what is sent, and what happens when Resend
// or the guard answers. Test branch and a fake sender only: nothing here can mail anyone. The clock is fixed
// in the past (11:30 IST on 10 Nov 2026), so rows other tests leave in the database (created today) are
// never selected.
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

// `allowed` stands for the development allow-list: null = no limit (as in production).
const fakes = vi.hoisted(() => ({
  send: vi.fn(),
  allowed: null as string[] | null,
  failLinks: 0, // how many next unsubscribe-link builds should fail (a database blip before the send)
}));
vi.mock("../../src/lib/email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email.js")>()),
  sendEmail: fakes.send,
  isRecipientAllowed: (to: string) =>
    fakes.allowed === null || fakes.allowed.includes(to),
  devAllowedRecipients: () => fakes.allowed,
}));
vi.mock("../../src/services/emailOptOut.service.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../src/services/emailOptOut.service.js")
    >();
  return {
    ...real,
    buildUnsubscribeLinks: (
      ...args: Parameters<typeof real.buildUnsubscribeLinks>
    ) =>
      fakes.failLinks > 0
        ? (fakes.failLinks--, Promise.reject(new Error("database blip")))
        : real.buildUnsubscribeLinks(...args),
  };
});

import { prisma } from "../../src/lib/prisma.js";
import { EmailGuardRefusal, EmailSendError } from "../../src/lib/email.js";
import {
  claimDueReminders,
  markLostClaims,
  purgeOldEmailRows,
  sweepReminders,
} from "../../src/services/reminder.service.js";
import { getReminderSettings } from "../../src/services/reminderSettings.service.js";
import { getReminderStatus } from "../../src/services/reminder.service.js";
import { EMAIL_CLAIM_LOCK_KEY } from "../../src/config/reminders.js";
import type {
  OrderSessionStatus,
  OrderStatus,
  ReminderSetting,
} from "../../src/generated/prisma/client.js";

type Setting = Omit<ReminderSetting, "id" | "createdAt" | "updatedAt">;

const MARK = "__vitest_reminders__";
const DOMAIN = "@vitest-reminders.test";
const NOW = new Date("2026-11-10T06:00:00.000Z"); // 11:30 IST, inside the 9:00 to 20:00 window
const H = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);
const ahead = (hours: number) => new Date(NOW.getTime() + hours * H);

let comicId = "";
let seq = 0;
const email = (label = "p") => `${label}-${++seq}${DOMAIN}`;

const USER_ID = "vtr-user-1";

async function cleanupRows() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  await prisma.reminderStop.deleteMany({
    where: { orderSessionId: { in: sessions.map((s) => s.id) } },
  });
  await prisma.reminderSend.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.emailUnsubscribeToken.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.emailOptOut.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.broadcast.deleteMany({
    where: { createdByEmail: { endsWith: DOMAIN } },
  });
  await prisma.order.deleteMany({
    where: { orderSession: { comic: { title: { startsWith: MARK } } } },
  });
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.coupon.deleteMany({ where: { code: { startsWith: "VTR-" } } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

async function cleanup() {
  await cleanupRows();
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

const SETTINGS_OFF: Setting = {
  previewEnabled: false,
  previewOffsetsHours: [3, 24, 96],
  previewEffectiveFrom: null,
  bookEnabled: false,
  bookOffsetsHours: [24, 72, 168],
  bookEffectiveFrom: null,
  reviewEnabled: false,
  reviewOffsetsHours: [168, 336],
  reviewEffectiveFrom: null,
  googleReviewUrl: null,
  reminderCouponCode: null,
  previewDeletionDays: null,
  dailyBudget: 100,
  reminderReserve: 10,
  perRunLimit: 50,
  windowStartHour: 9,
  windowEndHour: 20,
};

async function settings(over: Partial<Setting>) {
  await prisma.reminderSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...SETTINGS_OFF, ...over },
    update: { ...SETTINGS_OFF, ...over },
  });
}
const enableA = (over: Partial<Setting> = {}) =>
  settings({ previewEnabled: true, previewEffectiveFrom: ago(1000), ...over });
const enableB = (over: Partial<Setting> = {}) =>
  settings({ bookEnabled: true, bookEffectiveFrom: ago(1000), ...over });
const enableC = (over: Partial<Setting> = {}) =>
  settings({
    reviewEnabled: true,
    reviewEffectiveFrom: ago(1000),
    googleReviewUrl: "https://g.page/r/test/review",
    ...over,
  });

type SessionSpec = {
  status?: OrderSessionStatus;
  createdAt?: Date;
  updatedAt?: Date;
  expiresAt?: Date;
  email?: string | null;
  childName?: string | null;
  isSample?: boolean;
};

async function makeSession(spec: SessionSpec = {}) {
  const createdAt = spec.createdAt ?? ago(4);
  return prisma.orderSession.create({
    data: {
      comicId,
      status: spec.status ?? "PREVIEW_READY",
      createdAt,
      updatedAt: spec.updatedAt ?? ago(2),
      expiresAt: spec.expiresAt ?? new Date(createdAt.getTime() + 7 * 24 * H),
      notificationEmail: spec.email === undefined ? email() : spec.email,
      childName: spec.childName === undefined ? "Aarav" : spec.childName,
      isSample: spec.isSample ?? false,
    },
  });
}

type OrderSpec = {
  status?: OrderStatus;
  updatedAt?: Date;
  deliveredAt?: Date | null;
  razorpayPaymentId?: string | null;
  email?: string | null;
};

async function makeOrder(sessionId: string, spec: OrderSpec = {}) {
  return prisma.order.create({
    data: {
      orderSessionId: sessionId,
      amount: "599.00",
      currency: "INR",
      countryCode: "IN",
      coverType: "SOFTCOVER",
      status: spec.status ?? "CREATED",
      updatedAt: spec.updatedAt ?? ago(5),
      deliveredAt: spec.deliveredAt ?? null,
      razorpayPaymentId: spec.razorpayPaymentId ?? null,
      notificationEmail: spec.email ?? null,
    },
  });
}

/** Addresses the fake sender was asked to mail. */
const sentTo = () => fakes.send.mock.calls.map((c) => c[0].to as string);
const callFor = (to: string) =>
  fakes.send.mock.calls.map((c) => c[0]).find((p) => p.to === to);
const rows = (where: object = {}) =>
  prisma.reminderSend.findMany({
    where: { email: { endsWith: DOMAIN }, ...where },
  });

beforeAll(async () => {
  await cleanup();
  comicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} Pirate Island`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
        coverThumbnailUrls: ["https://img.example.test/pirate.webp"],
      },
    })
  ).id;
});

beforeEach(async () => {
  fakes.allowed = null;
  fakes.failLinks = 0;
  fakes.send
    .mockReset()
    .mockImplementation(async () => ({ messageId: `m-${++seq}` }));
  await cleanupRows();
  await settings({});
  // A test of the kept-until sentence switches the PREVIEWS deletion group on: never leave it on for the next test.
  await prisma.deletionGroupSetting.updateMany({
    where: { group: "PREVIEWS", mode: "ACTIVE" },
    data: { mode: "REPORT_ONLY" },
  });
});

afterAll(async () => {
  await prisma.deletionGroupSetting.updateMany({
    where: { group: "PREVIEWS", mode: "ACTIVE" },
    data: { mode: "REPORT_ONLY" },
  });
  await settings({});
  await cleanup();
  await prisma.$disconnect();
});

describe("shipped off", () => {
  it("with every reminder off, a sweep sends nothing and writes nothing, whatever is due", async () => {
    await makeSession();
    expect(await sweepReminders(NOW)).toBe(0);
    expect(fakes.send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("a fresh settings row has every reminder off with the planned defaults", async () => {
    await prisma.reminderSetting.deleteMany({});
    const s = await getReminderSettings();
    expect([s.previewEnabled, s.bookEnabled, s.reviewEnabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(s.previewOffsetsHours).toEqual([3, 24, 96]);
    expect(s.bookOffsetsHours).toEqual([24, 72, 168]);
    expect(s.reviewOffsetsHours).toEqual([168, 336]);
    expect([s.dailyBudget, s.reminderReserve, s.perRunLimit]).toEqual([
      30, 10, 10,
    ]);
    expect([s.windowStartHour, s.windowEndHour]).toEqual([9, 20]);
    expect([
      s.previewEffectiveFrom,
      s.bookEffectiveFrom,
      s.reviewEffectiveFrom,
    ]).toEqual([null, null, null]);
  });
});

describe("A, the unfinished preview", () => {
  it("sends once at the first offset, names the book not the child in the subject, and never twice", async () => {
    await enableA();
    const s = await makeSession({
      createdAt: ago(4),
      email: "parent" + DOMAIN,
      childName: "Aarav",
    });
    expect(await sweepReminders(NOW)).toBe(1);
    expect(sentTo()).toEqual(["parent" + DOMAIN]);
    const mail = callFor("parent" + DOMAIN);
    expect(mail.subject).toContain("Pirate Island");
    expect(mail.subject).not.toContain("Aarav");
    expect(mail.html).toContain(`/personalize/${s.id}/preview`);
    expect(mail.html).toContain("https://img.example.test/pirate.webp");
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: "PREVIEW_UNFINISHED",
      orderSessionId: s.id,
      offsetHours: 3,
      status: "SENT",
    });
    expect(mail.idempotencyKey).toBe(row!.id);
    // the same moment again, and a little later: nothing more for this offset
    expect(await sweepReminders(NOW)).toBe(0);
    expect(await sweepReminders(new Date(NOW.getTime() + 10 * 60 * 1000))).toBe(
      0
    );
    expect(fakes.send).toHaveBeenCalledTimes(1);
  });

  it("sends only the latest due offset when several are overdue, then the later ones in turn", async () => {
    await enableA();
    await makeSession({ createdAt: ago(30) }); // 3 h and 24 h both overdue; 24 h became due 6 h ago
    expect(await sweepReminders(NOW)).toBe(1);
    expect((await rows()).map((r) => r.offsetHours)).toEqual([24]);
    const later = new Date(NOW.getTime() + 70 * H); // 96 h offset falls due
    expect(await sweepReminders(later)).toBe(1);
    expect(
      (await rows()).map((r) => r.offsetHours).sort((a, b) => a - b)
    ).toEqual([24, 96]);
  });

  it("each status of a session, each order state: only the intended ones are selected (all 15 statuses)", async () => {
    await enableA();
    const ALL: OrderSessionStatus[] = [
      "CREATED",
      "PHOTO_UPLOADED",
      "GENERATING_PREVIEW",
      "PREVIEW_READY",
      "AWAITING_PAYMENT",
      "PAID",
      "GENERATING_PAID",
      "PAID_PAGES_READY",
      "CONFIRMED",
      "COMPILING_PDF",
      "PDF_FAILED",
      "SHIPMENT_QUEUED",
      "SHIPMENT_FAILED",
      "COMPLETED",
      "FAILED",
    ];
    const expected = new Map<string, boolean>();
    const labels = new Map<string, string>(); // names the case in a failure message
    for (const status of ALL) {
      const addr = email(status.toLowerCase());
      const s = await makeSession({ status, email: addr });
      if (status === "AWAITING_PAYMENT") {
        await makeOrder(s.id, { status: "CREATED", updatedAt: ago(5) });
        expected.set(addr, true); // left alone for 5 h, no payment id
      } else {
        expected.set(addr, status === "PREVIEW_READY");
      }
    }
    // the special cases
    const specials: [string, SessionSpec, OrderSpec | null, boolean][] = [
      ["expired preview", { expiresAt: ago(1) }, null, false],
      [
        "preview with a paid-looking order",
        {},
        { status: "CREATED", razorpayPaymentId: "pay_1" },
        false,
      ],
      [
        "awaiting payment, order touched 20 minutes ago",
        { status: "AWAITING_PAYMENT" },
        { status: "CREATED", updatedAt: ago(1 / 3) },
        false,
      ],
      [
        "awaiting payment, payment id present",
        { status: "AWAITING_PAYMENT" },
        { status: "CREATED", updatedAt: ago(5), razorpayPaymentId: "pay_2" },
        false,
      ],
      [
        "awaiting payment, order already PAID",
        { status: "AWAITING_PAYMENT" },
        { status: "PAID", updatedAt: ago(5) },
        false,
      ],
      [
        "touched 10 minutes ago (still active)",
        { updatedAt: ago(1 / 6) },
        null,
        false,
      ],
      ["a sample", { isSample: true }, null, false],
      ["no address anywhere", { email: null }, null, false],
      [
        "address only on the order",
        { email: null, status: "AWAITING_PAYMENT" },
        { status: "CREATED", updatedAt: ago(5), email: "fallback" + DOMAIN },
        true,
      ],
    ];
    for (const [label, sSpec, oSpec, want] of specials) {
      const addr = oSpec?.email ?? email("special");
      const s = await makeSession({
        email: "email" in sSpec ? sSpec.email : addr,
        ...sSpec,
      });
      if (oSpec) await makeOrder(s.id, oSpec);
      labels.set(addr, label);
      if (sSpec.email !== null) expected.set(addr, want);
      else if (want) expected.set(addr, true);
    }
    await sweepReminders(NOW);
    const mailed = new Set(sentTo());
    for (const [addr, want] of expected) {
      expect([addr, mailed.has(addr)], labels.get(addr) ?? addr).toEqual([
        addr,
        want,
      ]);
    }
    // and nobody outside the table was mailed (the session with no address anywhere gets nothing)
    expect(mailed.size).toBe([...expected.values()].filter(Boolean).length);
  });

  it("opted-out addresses get nothing", async () => {
    await enableA();
    const addr = email();
    await makeSession({ email: addr });
    await prisma.emailOptOut.create({ data: { email: addr } });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([]);
  });

  it("a kept-until date appears in the last reminder only for a PREVIEW_READY session and only while deletion of previews is switched on", async () => {
    await enableA();
    await prisma.deletionGroupSetting.update({ where: { group: "PREVIEWS" }, data: { mode: "ACTIVE" } });
    const ready = await makeSession({
      createdAt: ago(100),
      email: email("ready"),
    }); // 96 h offset due 4 h ago
    const awaiting = await makeSession({
      createdAt: ago(100),
      status: "AWAITING_PAYMENT",
      email: email("await"),
    });
    await makeOrder(awaiting.id, { status: "CREATED", updatedAt: ago(5) });
    await sweepReminders(NOW);
    const readyMail = callFor(ready.notificationEmail!);
    const awaitMail = callFor(awaiting.notificationEmail!);
    expect(readyMail.html).toContain("is kept until");
    expect(readyMail.html).toContain("13 November 2026"); // created 6 Nov 2026 (IST) plus its 7 days
    expect(awaitMail.html).not.toContain("is kept until");

    fakes.send.mockClear();
    await prisma.reminderSend.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
    await prisma.deletionGroupSetting.update({ where: { group: "PREVIEWS" }, data: { mode: "REPORT_ONLY" } });
    await sweepReminders(NOW);
    expect(callFor(ready.notificationEmail!).html).not.toContain("is kept until");
  });

  it("a preview whose photo alone was deleted gets no reminder either (feature 6)", async () => {
    await enableA();
    const gone = await makeSession({ createdAt: ago(100), email: email("photo") });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${NOW} WHERE "id" = ${gone.id}`;
    await sweepReminders(NOW);
    expect(sentTo()).not.toContain(gone.notificationEmail);
  });

  it("a preview whose files were deleted gets no reminder (feature 6)", async () => {
    await enableA();
    const gone = await makeSession({ createdAt: ago(100), email: email("gone") });
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${NOW} WHERE "id" = ${gone.id}`;
    await sweepReminders(NOW);
    expect(sentTo()).not.toContain(gone.notificationEmail);
  });

  it("a coupon code appears in the last reminder only while the coupon is active, open to everyone and in its dates", async () => {
    const make = (code: string, over: object = {}) =>
      prisma.coupon.create({
        data: {
          code,
          name: "t",
          discountType: "PERCENT",
          percentOff: "10.00",
          createdById: "t",
          updatedById: "t",
          ...over,
        },
      });
    await make("VTR-GOOD");
    await make("VTR-OFF", { isActive: false });
    await make("VTR-OLD", { endsAt: ago(1) });
    await make("VTR-SOON", { startsAt: ahead(48) });
    await prisma.user.create({
      data: { id: USER_ID, name: "t", email: "vtr-user-1" + DOMAIN },
    });
    await make("VTR-MINE", { restrictedToUserId: USER_ID }); // for one customer only
    await make("VTR-CAP", { usageLimit: 5 }); // a total cap that may have run out
    await make("VTR-SU", { kind: "SINGLE_USE", usageLimit: 1 });
    await make("VTR-IN", { countryCodes: ["IN"] }); // not valid everywhere
    await make("VTR-HC", { coverTypes: ["HARDCOVER"] }); // not valid for every cover
    await make("VTR-SOME", { allComics: false }); // not valid for every book
    await make("VTR-FIRST", { firstOrderOnly: true }); // checkout refuses it to a repeat customer
    await make("VTR-PCL", { perCustomerLimit: 1 }); // may already be used up by this customer
    await make("VTR-FIXED", {
      discountType: "FIXED",
      percentOff: null,
      amountOff: "50.00",
      currency: "INR",
    }); // a fixed amount fails for a customer paying in another currency
    for (const [code, shown] of [
      ["VTR-GOOD", true],
      ["VTR-OFF", false],
      ["VTR-OLD", false],
      ["VTR-SOON", false],
      ["VTR-MINE", false],
      ["VTR-CAP", false],
      ["VTR-SU", false],
      ["VTR-IN", false],
      ["VTR-HC", false],
      ["VTR-SOME", false],
      ["VTR-FIRST", false],
      ["VTR-PCL", false],
      ["VTR-FIXED", false],
      ["MISSING", false],
    ] as const) {
      fakes.send.mockClear();
      await prisma.reminderSend.deleteMany({
        where: { email: { endsWith: DOMAIN } },
      });
      await prisma.orderSession.deleteMany({
        where: { comic: { title: { startsWith: MARK } } },
      });
      await enableA({ reminderCouponCode: code });
      const s = await makeSession({ createdAt: ago(100) });
      await sweepReminders(NOW);
      expect(callFor(s.notificationEmail!).html.includes(code), code).toBe(
        shown
      );
    }
    // and never in the first or middle reminder
    fakes.send.mockClear();
    await prisma.reminderSend.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
    await prisma.orderSession.deleteMany({
      where: { comic: { title: { startsWith: MARK } } },
    });
    await enableA({ reminderCouponCode: "VTR-GOOD" });
    const early = await makeSession({ createdAt: ago(4) });
    await sweepReminders(NOW);
    expect(callFor(early.notificationEmail!).html).not.toContain("VTR-GOOD");
  }, 120_000); // one coupon per loop pass on a remote database
});

describe("enabling and editing never mail the history (catch-up and effectiveFrom)", () => {
  it("rows 30 days, 4 days and 2 hours old: at most one mail each, none for the 30-day one", async () => {
    await enableA();
    const old = await makeSession({
      createdAt: ago(30 * 24),
      email: email("old"),
      expiresAt: ahead(24),
    });
    const mid = await makeSession({ createdAt: ago(100), email: email("mid") });
    const fresh = await makeSession({
      createdAt: ago(3.5),
      email: email("fresh"),
    });
    await sweepReminders(NOW);
    const mailed = sentTo();
    expect(mailed).not.toContain(old.notificationEmail);
    expect(mailed).toContain(mid.notificationEmail);
    expect(mailed).toContain(fresh.notificationEmail);
    expect(mailed.length).toBe(2);
  });

  it("switching a reminder on now mails nobody whose offsets were due before the switch", async () => {
    await enableA({ previewEffectiveFrom: NOW }); // switched on this very moment
    await makeSession({ createdAt: ago(10) });
    expect(await sweepReminders(NOW)).toBe(0);
    // a customer whose first offset falls due after the switch is mailed then
    expect(await sweepReminders(new Date(NOW.getTime() + 24 * H))).toBe(1);
  });

  it("lowering an offset does not release a burst: it restarts from the change", async () => {
    await enableA({ previewOffsetsHours: [1], previewEffectiveFrom: NOW });
    await makeSession({ createdAt: ago(20) });
    expect(await sweepReminders(NOW)).toBe(0);
  });

  it("an edited list keeps remembering what was sent", async () => {
    await enableA();
    const s = await makeSession({ createdAt: ago(100) }); // 96 h due 4 h ago
    await sweepReminders(NOW);
    expect((await rows()).map((r) => r.offsetHours)).toEqual([96]);
    await enableA({ previewOffsetsHours: [48, 72, 96] }); // older offsets than the one already sent
    fakes.send.mockClear();
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
    expect(s.id).toBeTruthy();
  });
});

describe("B, the book not sent to print", () => {
  const readySession = (over: SessionSpec = {}) =>
    makeSession({
      status: "PAID_PAGES_READY",
      createdAt: ago(60),
      updatedAt: ago(30),
      ...over,
    });

  it("sends at the offset after the book became ready, to the preview page, with its own stop link and no unsubscribe header", async () => {
    await enableB();
    const s = await readySession({ email: "buyer" + DOMAIN });
    await makeOrder(s.id, { status: "GENERATED", updatedAt: ago(25) });
    expect(await sweepReminders(NOW)).toBe(1);
    const mail = callFor("buyer" + DOMAIN);
    expect(mail.subject).toContain("Pirate Island");
    expect(mail.subject).not.toContain("Aarav");
    expect(mail.html).toContain(`/personalize/${s.id}/preview`);
    expect(mail.html).toContain("Stop reminders about this book");
    expect(mail.html).not.toContain("<img");
    expect(mail.headers).toBeUndefined();
    const token = await prisma.emailUnsubscribeToken.findFirst({
      where: { email: "buyer" + DOMAIN },
    });
    expect(token).toMatchObject({
      scope: "ORDER_REMINDER",
      orderSessionId: s.id,
    });
    expect(token!.token.length).toBeGreaterThanOrEqual(32);
  });

  it("every order status: only GENERATED (with a ready session) is selected", async () => {
    await enableB();
    const STATUSES: OrderStatus[] = [
      "CREATED",
      "PAID",
      "GENERATED",
      "CONFIRMED",
      "SHIPROCKET_FAILED",
      "READY_TO_SHIP",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ];
    const want = new Map<string, boolean>();
    for (const status of STATUSES) {
      const s = await readySession({ email: email(status.toLowerCase()) });
      await makeOrder(s.id, {
        status,
        updatedAt: ago(25),
        deliveredAt: status === "DELIVERED" ? ago(30) : null,
      });
      want.set(s.notificationEmail!, status === "GENERATED");
    }
    const notReady = await makeSession({
      status: "GENERATING_PAID",
      email: email("notready"),
      createdAt: ago(60),
    });
    await makeOrder(notReady.id, { status: "GENERATED", updatedAt: ago(25) });
    want.set(notReady.notificationEmail!, false);
    const sample = await readySession({
      isSample: true,
      email: email("sample"),
    });
    await makeOrder(sample.id, { status: "GENERATED", updatedAt: ago(25) });
    want.set(sample.notificationEmail!, false);
    await sweepReminders(NOW);
    const mailed = new Set(sentTo());
    for (const [addr, w] of want)
      expect([addr, mailed.has(addr)]).toEqual([addr, w]);
  });

  it("stops the moment the customer presses Send to Print (order leaves GENERATED)", async () => {
    await enableB();
    const s = await readySession({ email: "stopper" + DOMAIN });
    const order = await makeOrder(s.id, {
      status: "GENERATED",
      updatedAt: ago(25),
    });
    await sweepReminders(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(1);
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "CONFIRMED" },
    });
    fakes.send.mockClear();
    await sweepReminders(new Date(NOW.getTime() + 60 * H));
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("the customer's own stop link ends B for that book only, and a general opt-out does not stop B", async () => {
    await enableB();
    const stopped = await readySession({ email: "stopped" + DOMAIN });
    const optedOut = await readySession({ email: "optedout" + DOMAIN });
    await makeOrder(stopped.id, { status: "GENERATED", updatedAt: ago(25) });
    await makeOrder(optedOut.id, { status: "GENERATED", updatedAt: ago(25) });
    await prisma.reminderStop.create({
      data: { kind: "BOOK_NOT_SENT", orderSessionId: stopped.id },
    });
    await prisma.emailOptOut.create({ data: { email: "optedout" + DOMAIN } });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual(["optedout" + DOMAIN]);
    await prisma.reminderStop.deleteMany({
      where: { orderSessionId: stopped.id },
    });
  });
});

describe("C, the review request", () => {
  it("sends the link set by the admin, once per offset, only for DELIVERED orders with a delivery date", async () => {
    await enableC();
    const mk = async (
      label: string,
      status: OrderStatus,
      deliveredAt: Date | null
    ) => {
      const s = await makeSession({
        status: "COMPLETED",
        email: email(label),
        createdAt: ago(400),
      });
      await makeOrder(s.id, { status, deliveredAt, updatedAt: ago(10) });
      return s.notificationEmail!;
    };
    const good = await mk("good", "DELIVERED", ago(180)); // 168 h offset due 12 h ago
    const noDate = await mk("nodate", "DELIVERED", null);
    const shipped = await mk("shipped", "SHIPPED", ago(180));
    const tooOld = await mk("old", "DELIVERED", ago(24 * 20));
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([good]);
    expect(sentTo()).not.toContain(noDate);
    expect(sentTo()).not.toContain(shipped);
    expect(sentTo()).not.toContain(tooOld);
    const mail = callFor(good);
    expect(mail.html).toContain("https://g.page/r/test/review");
    expect(mail.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click"
    );
    expect(mail.headers["List-Unsubscribe"]).toMatch(
      /\/api\/public\/email\/unsubscribe\//
    );
    await sweepReminders(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing without a review link, and an opt-out stops it", async () => {
    await enableC({ googleReviewUrl: null });
    const s = await makeSession({ status: "COMPLETED", createdAt: ago(400) });
    await makeOrder(s.id, { status: "DELIVERED", deliveredAt: ago(180) });
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0); // the claim was released, not left behind

    await enableC();
    await prisma.emailOptOut.create({ data: { email: s.notificationEmail! } });
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
  });
});

describe("send window, limits and the one-per-address rule", () => {
  it("sends only inside the 9:00 to 20:00 IST window", async () => {
    await enableA({ previewOffsetsHours: [3] });
    // first offset due 23:00 UTC on 9 Nov, so it is overdue (within 24 h) at every call below
    await makeSession({
      createdAt: new Date("2026-11-09T20:00:00.000Z"),
      updatedAt: new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(await sweepReminders(new Date("2026-11-10T03:29:59.000Z"))).toBe(0); // 08:59:59
    expect(await sweepReminders(new Date("2026-11-10T14:30:00.000Z"))).toBe(0); // 20:00
    expect(fakes.send).not.toHaveBeenCalled();
    expect(await sweepReminders(new Date("2026-11-10T03:30:00.000Z"))).toBe(1); // 09:00 exactly
  });

  it("an offset due at night is still sent next morning if it is within the 24 hours", async () => {
    await enableA({ previewOffsetsHours: [3] });
    await makeSession({
      createdAt: new Date("2026-11-10T14:00:00.000Z"),
      updatedAt: new Date("2026-11-10T14:00:00.000Z"),
    }); // 19:30 IST
    // due 17:00 UTC = 22:30 IST (outside the window); next morning 09:00 IST = 03:30 UTC
    expect(await sweepReminders(new Date("2026-11-10T20:00:00.000Z"))).toBe(0);
    expect(await sweepReminders(new Date("2026-11-11T03:30:00.000Z"))).toBe(1);
  });

  it("the daily budget is shared with broadcast recipients, counts claimed, sent and lost, and starts a new Indian day at 18:30 UTC", async () => {
    await enableA({ dailyBudget: 3, previewOffsetsHours: [3] });
    for (let i = 0; i < 4; i++) await makeSession({ email: email("b") });
    const b = await prisma.broadcast.create({
      data: {
        subject: "s",
        heading: "h",
        message: "m",
        createdById: "t",
        createdByEmail: "x" + DOMAIN,
      },
    });
    await prisma.broadcastRecipient.create({
      data: {
        broadcastId: b.id,
        email: email("r"),
        status: "SENT",
        claimedAt: ago(1),
      },
    });
    expect(await sweepReminders(NOW)).toBe(2); // 3 minus 1 used by the broadcast
    expect(await sweepReminders(NOW)).toBe(0); // 2 reminders plus 1 broadcast recipient: the budget is spent
    // the previous Indian day's rows do not count
    await prisma.reminderSend.updateMany({
      where: { email: { endsWith: DOMAIN } },
      data: { claimedAt: new Date("2026-11-09T05:00:00.000Z") },
    });
    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: b.id },
      data: { claimedAt: new Date("2026-11-09T05:00:00.000Z") },
    });
    // a new day: the budget is free again, and the two sessions that had no turn yet now get it
    expect(await sweepReminders(NOW)).toBe(2);
    expect((await rows()).length).toBe(4);
  });

  it("a LOST claim still counts against the budget and is never resent", async () => {
    await enableA({ dailyBudget: 1, previewOffsetsHours: [3] });
    await makeSession({ email: email("first") });
    fakes.send.mockRejectedValueOnce(new Error("socket hang up")); // result unknown
    await sweepReminders(NOW);
    expect((await rows())[0]!.status).toBe("CLAIMED");
    await markLostClaims(new Date(NOW.getTime() + 2 * H));
    expect((await rows())[0]!.status).toBe("LOST");
    await makeSession({ email: email("second") });
    fakes.send.mockClear();
    expect(await sweepReminders(NOW)).toBe(0); // budget of 1 is spent by the LOST row
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("per-run limit: at most that many are claimed, the rest wait for the next run", async () => {
    await enableA({ perRunLimit: 2, previewOffsetsHours: [3] });
    for (let i = 0; i < 5; i++) await makeSession({ email: email("lim") });
    expect(await sweepReminders(NOW)).toBe(2);
    expect(await sweepReminders(NOW)).toBe(2);
    expect(await sweepReminders(NOW)).toBe(1);
    expect(await sweepReminders(NOW)).toBe(0);
  });

  it("one address gets one reminder a day: a second session or kind waits; the same session's next offset is not held back", async () => {
    await enableA({ previewOffsetsHours: [3, 6] });
    const addr = "twice" + DOMAIN;
    const one = await makeSession({ email: addr, createdAt: ago(4) });
    const two = await makeSession({ email: addr, createdAt: ago(4) });
    expect(await sweepReminders(NOW)).toBe(1); // only one of the two sessions
    const sentSession = (await rows())[0]!.orderSessionId;
    expect([one.id, two.id]).toContain(sentSession);
    // later the same session's next offset (6 h) is the admin's cadence and goes out; the other session still waits
    const later = new Date(NOW.getTime() + 3 * H);
    await prisma.orderSession.updateMany({
      where: { id: { in: [one.id, two.id] } },
      data: { updatedAt: ago(10) },
    });
    expect(await sweepReminders(later)).toBe(1);
    expect((await rows({ orderSessionId: sentSession })).length).toBe(2);
  });

  it("an address mailed in an earlier run holds back a different session for 24 hours, then lets it through", async () => {
    await enableA({ previewOffsetsHours: [3] });
    const addr = "held" + DOMAIN;
    const first = await makeSession({ email: addr, createdAt: ago(4) }); // due now
    const second = await makeSession({ email: addr, createdAt: ago(1) }); // due 2 h from now
    expect(await sweepReminders(NOW)).toBe(1);
    expect((await rows())[0]!.orderSessionId).toBe(first.id);
    // the second session is due, but its address was mailed less than 24 h ago
    expect(await sweepReminders(new Date(NOW.getTime() + 2.5 * H))).toBe(0);
    expect(await rows({ orderSessionId: second.id })).toHaveLength(0);
    // 24 h and a bit after the first mail, and still inside the second one's own 24 h catch-up
    expect(await sweepReminders(new Date(NOW.getTime() + 24.5 * H))).toBe(1);
    expect(await rows({ orderSessionId: second.id })).toHaveLength(1);
  });

  it("a claim waits while another claim holds the lock, and claims nothing until it is released", async () => {
    await enableA({ previewOffsetsHours: [3] });
    await makeSession({ email: email("lock") });
    const settingsRow = await getReminderSettings();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EMAIL_CLAIM_LOCK_KEY}))`;
        held();
        await gate;
      },
      { timeout: 30_000 }
    );
    await holding;
    let finished = false;
    const claiming = claimDueReminders(settingsRow, NOW).then((claims) => {
      finished = true;
      return claims;
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(finished).toBe(false);
    expect(await rows()).toHaveLength(0);
    release();
    await holder;
    expect((await claiming).length).toBe(1);
  });

  it("two overlapping claims never exceed the limits and never claim the same reminder twice", async () => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 3, dailyBudget: 3 });
    for (let i = 0; i < 6; i++) await makeSession({ email: email("race") });
    const settingsRow = await getReminderSettings();
    const [x, y] = await Promise.all([
      claimDueReminders(settingsRow, NOW),
      claimDueReminders(settingsRow, NOW),
    ]);
    expect(x.length + y.length).toBe(3);
    expect(new Set([...x, ...y].map((c) => c.orderSessionId)).size).toBe(3);
    expect(await rows()).toHaveLength(3);
  });
});

describe("what Resend and the guard answer", () => {
  const due = async (n = 1) => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 10 });
    const made = [];
    for (let i = 0; i < n; i++)
      made.push(await makeSession({ email: email("out") }));
    return made;
  };

  it("a guard refusal releases the claim: nothing failed, nothing suppressed, nothing counted", async () => {
    await due();
    fakes.send.mockRejectedValue(new EmailGuardRefusal());
    expect(await sweepReminders(NOW)).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(
      await prisma.emailOptOut.count({ where: { email: { endsWith: DOMAIN } } })
    ).toBe(0);
    fakes.send.mockImplementation(async () => ({ messageId: "ok" }));
    expect(await sweepReminders(NOW)).toBe(1); // picked up again by the next run
  });

  it("a rate limit releases every unsent claim and stops the run", async () => {
    await due(3);
    fakes.send.mockRejectedValue(
      new EmailSendError("limit (HTTP 429)", "rate_limit_exceeded", 429)
    );
    expect(await sweepReminders(NOW)).toBe(0);
    expect(fakes.send).toHaveBeenCalledTimes(1); // the run stopped after the first
    expect(await rows()).toHaveLength(0); // all three released, nothing lost or counted
    fakes.send.mockImplementation(async () => ({ messageId: "ok" }));
    expect(await sweepReminders(NOW)).toBe(3);
  });

  it("a definite refusal marks the row FAILED with Resend's name only, never retried, and suppresses nobody", async () => {
    const [s] = await due();
    fakes.send.mockRejectedValue(
      new EmailSendError(
        "secret text " + s!.notificationEmail + " (HTTP 422)",
        "validation_error",
        422
      )
    );
    await sweepReminders(NOW);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: "FAILED",
      errorName: "validation_error",
    });
    expect(row!.errorName).not.toContain(s!.notificationEmail!); // the address lives in `email`, never in the error
    expect(
      await prisma.emailOptOut.count({ where: { email: { endsWith: DOMAIN } } })
    ).toBe(0);
    fakes.send.mockClear();
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled(); // FAILED consumes the offset
  });

  it("a FAILED reminder is skipped at selection, so it cannot take the only slot of every run from the others", async () => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 1 });
    const failed = await makeSession({
      email: email("failed"),
      createdAt: ago(4.5),
    }); // older, so first in line
    const waiting = await makeSession({
      email: email("waiting"),
      createdAt: ago(4),
    });
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: failed.id,
        offsetHours: 3,
        email: failed.notificationEmail!,
        status: "FAILED",
        errorName: "validation_error",
        claimedAt: ago(1),
      },
    });
    expect(await sweepReminders(NOW)).toBe(1);
    expect(sentTo()).toEqual([waiting.notificationEmail]);
  });

  it("an unknown result leaves the claim, which becomes LOST after an hour and is never resent", async () => {
    await due();
    fakes.send.mockRejectedValue(new Error("socket hang up"));
    await sweepReminders(NOW);
    expect((await rows())[0]!.status).toBe("CLAIMED");
    expect(await markLostClaims(new Date(NOW.getTime() + 59 * 60 * 1000))).toBe(
      0
    );
    expect(await markLostClaims(new Date(NOW.getTime() + 61 * 60 * 1000))).toBe(
      1
    );
    fakes.send.mockClear();
    fakes.send.mockImplementation(async () => ({ messageId: "ok" }));
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("the Resend idempotency key is the claim id", async () => {
    await due();
    await sweepReminders(NOW);
    const [row] = await rows();
    expect(fakes.send.mock.calls[0]![0].idempotencyKey).toBe(row!.id);
  });
});

describe("review round: setup errors, outages, development limits", () => {
  const due = async (n = 1) => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 10 });
    const made = [];
    for (let i = 0; i < n; i++)
      made.push(await makeSession({ email: email("rr") }));
    return made;
  };

  for (const [status, name] of [
    [401, "invalid_api_key"],
    [403, "validation_error"],
  ] as const) {
    it(`a setup error (HTTP ${status}) stops the run and gives every claim back: nobody's reminder is burned`, async () => {
      await due(3);
      fakes.send.mockRejectedValue(
        new EmailSendError(`x (HTTP ${status})`, name, status)
      );
      expect(await sweepReminders(NOW)).toBe(0);
      expect(fakes.send).toHaveBeenCalledTimes(1); // the run stopped at the first answer
      expect(await rows()).toHaveLength(0); // nothing FAILED, nothing counted
      // once the account is fixed, all three still get their reminder
      fakes.send
        .mockReset()
        .mockImplementation(async () => ({ messageId: `m-${++seq}` }));
      expect(await sweepReminders(NOW)).toBe(3);
    });
  }

  it("an idempotency conflict (HTTP 409) is not a failure: the first attempt may have gone through", async () => {
    await due();
    fakes.send.mockRejectedValue(
      new EmailSendError(
        "conflict (HTTP 409)",
        "concurrent_idempotent_requests",
        409
      )
    );
    await sweepReminders(NOW);
    const [row] = await rows();
    expect(row!.status).toBe("CLAIMED");
    fakes.send.mockClear();
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled(); // and it is never resent
  });

  it("several sends in a row with no answer stop the run (Resend or the network is down)", async () => {
    await due(6);
    fakes.send.mockRejectedValue(new Error("socket hang up"));
    await sweepReminders(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(3);
    // the three tried stay claimed; the other three were given back, not lost
    expect((await rows()).map((r) => r.status)).toEqual([
      "CLAIMED",
      "CLAIMED",
      "CLAIMED",
    ]);
  });

  it("an answer in between resets the count of sends with no answer", async () => {
    await due(5);
    let call = 0;
    fakes.send.mockImplementation(async () => {
      call += 1;
      if (call === 3) return { messageId: "ok" };
      throw new Error("socket hang up");
    });
    await sweepReminders(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(5); // 2 unknown, 1 sent, 2 unknown: never 3 in a row
  });

  it("outside production, addresses off the allow-list are left unclaimed and cannot take the slots of the allowed one", async () => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 2 });
    for (let i = 0; i < 5; i++)
      await makeSession({ email: email("blocked"), createdAt: ago(5) });
    const mine = email("mine");
    await makeSession({ email: mine, createdAt: ago(4) }); // newer than the blocked ones
    fakes.allowed = [mine];
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([mine]);
    expect(await rows({ email: { not: mine } })).toHaveLength(0); // no claim for the others
  });

  it("the report card counts what was sent, refused, bought after a reminder, and opted out", async () => {
    await settings({});
    const before = (await getReminderStatus(NOW)).recent;
    const paid = await makeSession({ email: email("paid") });
    const created = await makeSession({ email: email("created") });
    const noOrder = await makeSession({ email: email("none") });
    const awaiting = await makeSession({
      email: email("await"),
      status: "AWAITING_PAYMENT",
    });
    const send = (
      id: string,
      who: string,
      status: "SENT" | "FAILED",
      at: Date
    ) =>
      prisma.reminderSend.create({
        data: {
          kind: "PREVIEW_UNFINISHED",
          orderSessionId: id,
          offsetHours: 3,
          email: who,
          status,
          claimedAt: at,
          sentAt: status === "SENT" ? at : null,
        },
      });
    for (const s of [paid, created, noOrder, awaiting]) {
      await send(s.id, s.notificationEmail!, "SENT", ago(10));
    }
    await send("fake-failed", email("f"), "FAILED", ago(10));
    await makeOrder(paid.id, { status: "PAID" });
    await makeOrder(created.id, { status: "CREATED" }); // started, not paid: not a purchase
    // the customer left in AWAITING_PAYMENT (the order was started BEFORE the reminder) and paid later
    await makeOrder(awaiting.id, { status: "PAID" });
    await prisma.order.updateMany({
      where: { orderSessionId: awaiting.id },
      data: { createdAt: ago(20) },
    });
    await prisma.emailOptOut.create({ data: { email: email("oo") } });
    const after = (await getReminderStatus(NOW)).recent;
    expect(after.sentPreviewReminders - before.sentPreviewReminders).toBe(4);
    expect(after.boughtAfterReminder - before.boughtAfterReminder).toBe(2);
    expect(after.refused - before.refused).toBe(1);
    expect(after.optedOutTotal - before.optedOutTotal).toBe(1);
  });
});

describe("review round 2", () => {
  const readySession = (over: SessionSpec = {}) =>
    makeSession({
      status: "PAID_PAGES_READY",
      createdAt: ago(60),
      updatedAt: ago(30),
      ...over,
    });

  it("paid customers come before unfinished previews when the budget is short: B is sent first, not crowded out by A", async () => {
    await settings({
      previewEnabled: true,
      previewEffectiveFrom: ago(1000),
      previewOffsetsHours: [3],
      bookEnabled: true,
      bookEffectiveFrom: ago(1000),
      perRunLimit: 1,
    });
    for (let i = 0; i < 3; i++) {
      await makeSession({ email: email("a"), createdAt: ago(5) }); // older than the buyer's session
    }
    const buyer = "buyer-first" + DOMAIN;
    const s = await readySession({ email: buyer });
    await makeOrder(s.id, { status: "GENERATED", updatedAt: ago(25) });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([buyer]);
  });

  it("a send that is last in the list but the first this customer gets is not called a final reminder; after an earlier one it is", async () => {
    await enableA();
    const fresh = await makeSession({ createdAt: ago(100) }); // only the 96 h offset is due; 3 h and 24 h never went
    const reminded = await makeSession({ createdAt: ago(100) });
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: reminded.id,
        offsetHours: 24,
        email: reminded.notificationEmail!,
        status: "SENT",
        claimedAt: ago(70),
        sentAt: ago(70),
      },
    });
    await sweepReminders(NOW);
    expect(callFor(fresh.notificationEmail!).subject).not.toContain(
      "final reminder"
    );
    expect(callFor(reminded.notificationEmail!).subject).toContain(
      "final reminder"
    );
  });

  it("a failure before the send (the unsubscribe link cannot be written) gives the claim back: nothing sent, nothing counted, and the next run sends it", async () => {
    await enableA({ previewOffsetsHours: [3] });
    await makeSession({ email: email("prep") });
    fakes.failLinks = 1;
    expect(await sweepReminders(NOW)).toBe(0);
    expect(fakes.send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
    expect(await sweepReminders(NOW)).toBe(1);
  });

  it("three refusals in a row stop the run: a setup error that looks like a bad address cannot burn the whole day", async () => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 10 });
    for (let i = 0; i < 6; i++) await makeSession({ email: email("rf") });
    fakes.send.mockRejectedValue(
      new EmailSendError("bad (HTTP 422)", "validation_error", 422)
    );
    await sweepReminders(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(3);
    expect((await rows()).map((r) => r.status)).toEqual([
      "FAILED",
      "FAILED",
      "FAILED",
    ]);
  });

  it("a preview is not reminded when the same address paid for another preview", async () => {
    await enableA({ previewOffsetsHours: [3] });
    const shared = email("two");
    const first = await makeSession({ email: shared, createdAt: ago(5) });
    const second = await makeSession({ email: shared, createdAt: ago(4) });
    await makeOrder(second.id, { status: "PAID" });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([]); // the first would say "you have not bought" to someone who did
    expect(first.id).not.toBe(second.id);
  });

  it("a reminder that was refused never reached the customer, so the next one is not called a final reminder", async () => {
    await enableA();
    const s = await makeSession({ createdAt: ago(100) });
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: s.id,
        offsetHours: 24,
        email: s.notificationEmail!,
        status: "FAILED",
        claimedAt: ago(70),
        errorName: "validation_error",
      },
    });
    await sweepReminders(NOW);
    expect(callFor(s.notificationEmail!).subject).not.toContain(
      "final reminder"
    );
  });

  it("a made-up social-login address is never mailed", async () => {
    await enableA({ previewOffsetsHours: [3] });
    await makeSession({ email: `${++seq}@facebook.local` });
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("the run stops starting sends once its time budget is used, and gives the untried claims back", async () => {
    await enableA({ previewOffsetsHours: [3], perRunLimit: 10 });
    for (let i = 0; i < 4; i++) await makeSession({ email: email("tb") });
    // A sender slower than the budget: the first send starts (the claim step is far inside the budget), and by
    // the time it answers the budget is gone, so no second send starts.
    let slow = true;
    fakes.send.mockImplementation(async () => {
      if (slow) await new Promise((r) => setTimeout(r, 4_000));
      return { messageId: `m-${++seq}` };
    });
    await sweepReminders(NOW, 3_000);
    expect(fakes.send).toHaveBeenCalledTimes(1);
    expect((await rows()).map((r) => r.status)).toEqual(["SENT"]); // the other claims were given back
    slow = false;
    expect(await sweepReminders(NOW)).toBe(3); // and the next run sends them
  }, 60_000);

  it("a broadcast never holds a reminder back, at any distance in time", async () => {
    await enableA({ previewOffsetsHours: [3] });
    const s = await makeSession({ email: email("bc") });
    const b = await prisma.broadcast.create({
      data: {
        subject: "s",
        heading: "h",
        message: "m",
        status: "SENDING",
        createdById: "t",
        createdByEmail: `bc-admin${DOMAIN}`,
      },
    });
    await prisma.broadcastRecipient.create({
      data: {
        broadcastId: b.id,
        email: s.notificationEmail!,
        status: "SENT",
        claimedAt: ago(0.1), // a broadcast mail a few minutes ago
        sentAt: ago(0.1),
      },
    });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([s.notificationEmail!]);
  });

  it("the one-reminder-a-day rule lets an address through at exactly 24 hours", async () => {
    await enableA({ previewOffsetsHours: [3] });
    const shared = email("edge");
    const other = await makeSession({ email: shared, createdAt: ago(40) });
    const mine = await makeSession({ email: shared, createdAt: ago(5) });
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: other.id,
        offsetHours: 3,
        email: shared,
        status: "SENT",
        claimedAt: ago(24), // exactly 24 hours before now
        sentAt: ago(24),
      },
    });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([shared]);
    expect(mine.id).toBeTruthy();
  });

  it("an address typed with capitals is mailed in lowercase and matched against the unsubscribe list in lowercase", async () => {
    await enableA({ previewOffsetsHours: [3] });
    const typed = `Mixed-Case-${++seq}${DOMAIN}`;
    await makeSession({ email: typed });
    await prisma.emailOptOut.create({ data: { email: typed.toLowerCase() } });
    await sweepReminders(NOW);
    expect(fakes.send).not.toHaveBeenCalled(); // opted out, whatever the capitals
    await prisma.emailOptOut.deleteMany({
      where: { email: typed.toLowerCase() },
    });
    await sweepReminders(NOW);
    expect(sentTo()).toEqual([typed.toLowerCase()]);
  });
});

describe("housekeeping", () => {
  it("purges send logs after 90 days and tokens after a year, and keeps opt-outs", async () => {
    const old = new Date(NOW.getTime() - 91 * 24 * H);
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: "x1",
        offsetHours: 3,
        email: "old" + DOMAIN,
        status: "SENT",
        claimedAt: old,
      },
    });
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: "x2",
        offsetHours: 3,
        email: "new" + DOMAIN,
        status: "SENT",
        claimedAt: ago(24 * 89),
      },
    });
    await prisma.emailUnsubscribeToken.create({
      data: {
        token: "t-old-" + seq,
        email: "old" + DOMAIN,
        createdAt: new Date(NOW.getTime() - 366 * 24 * H),
      },
    });
    await prisma.emailUnsubscribeToken.create({
      data: {
        token: "t-new-" + seq,
        email: "new" + DOMAIN,
        createdAt: new Date(NOW.getTime() - 364 * 24 * H),
      },
    });
    await prisma.emailOptOut.create({
      data: {
        email: "old" + DOMAIN,
        createdAt: new Date(NOW.getTime() - 1000 * 24 * H),
      },
    });
    await purgeOldEmailRows(NOW);
    expect((await rows()).map((r) => r.email)).toEqual(["new" + DOMAIN]);
    expect(
      (
        await prisma.emailUnsubscribeToken.findMany({
          where: { email: { endsWith: DOMAIN } },
        })
      ).map((t) => t.email)
    ).toEqual(["new" + DOMAIN]);
    expect(
      await prisma.emailOptOut.count({ where: { email: { endsWith: DOMAIN } } })
    ).toBe(1);
  });
});
