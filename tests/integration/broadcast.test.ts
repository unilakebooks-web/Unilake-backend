// Admin broadcast (feature 5): audience, draft rules, start, claim, send outcomes, cancel, counts. Test branch
// and a fake sender only: nothing here can mail anyone. The clock is fixed in the past (11:30 IST on 10 Nov
// 2026) so rows other tests leave (created today) never count against the day's budget.
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
  cancelBroadcast,
  claimBroadcastBatch,
  createBroadcast,
  deleteBroadcastDraft,
  finalizeBroadcasts,
  getAudienceCounts,
  getBroadcast,
  previewBroadcast,
  resolveAudience,
  sendTestBroadcast,
  startBroadcast,
  sweepBroadcasts,
  updateBroadcast,
} from "../../src/services/broadcast.service.js";
import { purgeOldEmailRows } from "../../src/services/reminder.service.js";
import { getReminderSettings } from "../../src/services/reminderSettings.service.js";
import type {
  BroadcastAudience,
  OrderStatus,
  ReminderSetting,
} from "../../src/generated/prisma/client.js";

type Setting = Omit<ReminderSetting, "id" | "createdAt" | "updatedAt">;

const MARK = "__vitest_broadcast__";
const DOMAIN = "@vitest-broadcast.test";
const NOW = new Date("2026-11-10T06:00:00.000Z"); // 11:30 IST, inside the window
const H = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);
const ADMIN = { id: "vtb-admin", email: `Admin${DOMAIN}` };

let comicId = "";
let seq = 0;
const addr = (label = "u") => `${label}-${++seq}${DOMAIN}`;

async function cleanupRows() {
  await prisma.broadcast.deleteMany({
    where: { createdByEmail: { endsWith: DOMAIN } },
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
  await prisma.order.deleteMany({
    where: { orderSession: { comic: { title: { startsWith: MARK } } } },
  });
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.marketingConsent.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.user.deleteMany({
    where: {
      OR: [{ email: { endsWith: DOMAIN } }, { id: { startsWith: "vtb-" } }],
    },
  });
}
async function cleanup() {
  await cleanupRows();
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

const SETTINGS: Setting = {
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
async function settings(over: Partial<Setting> = {}) {
  await prisma.reminderSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...SETTINGS, ...over },
    update: { ...SETTINGS, ...over },
  });
}

type UserSpec = {
  provider?: string; // a social sign-in account (the provider confirms the address)
  verified?: boolean;
  rawEmail?: (e: string) => string;
  role?: string;
  consent?: "yes" | "withdrawn" | "no";
  order?: OrderStatus;
  sample?: boolean;
};
async function makeUser(spec: UserSpec = {}) {
  const email = addr();
  const id = `vtb-${seq}`;
  await prisma.user.create({
    data: {
      id,
      name: "Test",
      email: spec.rawEmail ? spec.rawEmail(email) : email,
      role: spec.role ?? "USER",
      emailVerified: spec.verified ?? true,
    },
  });
  if (spec.provider) {
    await prisma.account.create({
      data: {
        id: `vtb-acct-${seq}`,
        accountId: `acct-${seq}`,
        providerId: spec.provider,
        userId: id,
      },
    });
  }
  if (spec.consent && spec.consent !== "no") {
    await prisma.marketingConsent.create({
      data: {
        userId: id,
        email,
        optedInAt: ago(100),
        withdrawnAt: spec.consent === "withdrawn" ? ago(50) : null,
        wordingVersion: "v1",
        source: "checkout",
      },
    });
  }
  if (spec.order) {
    const session = await prisma.orderSession.create({
      data: {
        comicId,
        userId: id,
        status: "PAID_PAGES_READY",
        expiresAt: ago(-1000),
        isSample: spec.sample ?? false,
        notificationEmail: email,
      },
    });
    await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "599.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "SOFTCOVER",
        status: spec.order,
      },
    });
  }
  return { id, email };
}

const body = (over: object = {}) => ({
  subject: "Diwali offer",
  heading: "A little something",
  message: "Hello there",
  ...over,
});
async function draft(
  audience: BroadcastAudience = "OPTED_IN_ONLY",
  over: object = {}
) {
  return createBroadcast({ ...body(over), audience } as never, ADMIN);
}
/** Starts a broadcast to exactly the given addresses (others in the test database are removed from it). */
async function startFor(audience: BroadcastAudience, mine: string[]) {
  const b = await draft(audience);
  const everyone = await resolveAudience(audience);
  await startBroadcast(b.id, everyone.length);
  await prisma.broadcastRecipient.deleteMany({
    where: { broadcastId: b.id, email: { notIn: mine } },
  });
  return b.id;
}
const mineIn = async (broadcastId: string) =>
  prisma.broadcastRecipient.findMany({
    where: { broadcastId, email: { endsWith: DOMAIN } },
  });
const sentTo = () => fakes.send.mock.calls.map((c) => c[0].to as string);

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
});
beforeEach(async () => {
  fakes.allowed = null;
  fakes.failLinks = 0;
  fakes.send
    .mockReset()
    .mockImplementation(async () => ({ messageId: `m-${++seq}` }));
  await cleanupRows();
  await settings();
});
afterAll(async () => {
  await settings();
  await cleanup();
  await prisma.$disconnect();
});

const mineOf = (emails: string[]) => emails.filter((e) => e.endsWith(DOMAIN));

describe("audience", () => {
  it("opted in only: ticked and not withdrawn, staff and opted-out left out", async () => {
    const yes = await makeUser({ consent: "yes" });
    await makeUser({ consent: "withdrawn" });
    await makeUser({ consent: "no" });
    await makeUser({ consent: "yes", role: "ADMIN" });
    await makeUser({ consent: "yes", role: "SUB_ADMIN" });
    const out = await makeUser({ consent: "yes" });
    await prisma.emailOptOut.create({ data: { email: out.email } });
    expect(mineOf(await resolveAudience("OPTED_IN_ONLY"))).toEqual([yes.email]);
  });

  it("opted in and customers: adds users with a real order, not a created, cancelled or sample one", async () => {
    const yes = await makeUser({ consent: "yes" });
    const paid: string[] = [];
    for (const status of [
      "PAID",
      "GENERATED",
      "CONFIRMED",
      "SHIPROCKET_FAILED",
      "READY_TO_SHIP",
      "SHIPPED",
      "DELIVERED",
    ] as const) {
      paid.push((await makeUser({ order: status })).email);
    }
    await makeUser({ order: "CREATED" });
    await makeUser({ order: "CANCELLED" });
    await makeUser({ order: "PAID", sample: true });
    await makeUser({ order: "PAID", role: "ADMIN" });
    const optedOutCustomer = await makeUser({ order: "PAID" });
    await prisma.emailOptOut.create({
      data: { email: optedOutCustomer.email },
    });
    // the same person twice (ticked and bought) appears once
    const both = await makeUser({ consent: "yes", order: "DELIVERED" });
    const got = mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"));
    expect(got.sort()).toEqual([yes.email, both.email, ...paid].sort());
    expect(new Set(got).size).toBe(got.length);
    const counts = await getAudienceCounts();
    expect(counts.optedInAndCustomers).toBeGreaterThanOrEqual(
      counts.optedInOnly
    );
  });
});

describe("a customer who unticked the offers box", () => {
  it("is left out of both audiences, although they bought; a customer who never ticked stays in the wider one", async () => {
    const unticked = await makeUser({
      consent: "withdrawn",
      order: "DELIVERED",
    });
    const never = await makeUser({ order: "DELIVERED" });
    const ticked = await makeUser({ consent: "yes", order: "DELIVERED" });
    expect(mineOf(await resolveAudience("OPTED_IN_ONLY"))).toEqual([
      ticked.email,
    ]);
    const wider = mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"));
    expect(wider.sort()).toEqual([never.email, ticked.email].sort());
    expect(wider).not.toContain(unticked.email);
  });

  it("ticking again brings them back, and the counts and the snapshot agree", async () => {
    const back = await makeUser({ consent: "withdrawn", order: "PAID" });
    const before = mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"));
    expect(before).not.toContain(back.email);
    await prisma.marketingConsent.updateMany({
      where: { email: back.email },
      data: { withdrawnAt: null },
    });
    const after = await resolveAudience("OPTED_IN_AND_CUSTOMERS");
    expect(after).toContain(back.email);
    const b = await draft("OPTED_IN_AND_CUSTOMERS");
    const started = await startBroadcast(b.id, after.length);
    expect(started.recipientCount).toBe(after.length);
    expect((await getAudienceCounts()).optedInAndCustomers).toBe(after.length);
  });
});

describe("an unsubscribe covers every address of that customer (D-122)", () => {
  /** Points the customer's session at another notification address (and, if asked, their order). */
  async function useAddresses(
    userId: string,
    sessionAddress: string,
    orderAddress?: string
  ) {
    await prisma.orderSession.updateMany({
      where: { userId },
      data: { notificationEmail: sessionAddress },
    });
    if (orderAddress !== undefined) {
      await prisma.order.updateMany({
        where: { orderSession: { userId } },
        data: { notificationEmail: orderAddress },
      });
    }
  }
  const optOut = (email: string) =>
    prisma.emailOptOut.create({ data: { email } });

  it("a customer who unsubscribed at their session's address is left out of both audiences, the counts, the snapshot and the claim", async () => {
    const other = addr("session");
    const gone = await makeUser({ consent: "yes", order: "DELIVERED" });
    await useAddresses(gone.id, other);
    const keep = await makeUser({ consent: "yes", order: "DELIVERED" });
    const before = await getAudienceCounts();
    await optOut(other);
    for (const audience of [
      "OPTED_IN_ONLY",
      "OPTED_IN_AND_CUSTOMERS",
    ] as const) {
      const got = mineOf(await resolveAudience(audience));
      expect(got).toEqual([keep.email]);
    }
    const after = await getAudienceCounts();
    expect(after.optedInOnly).toBe(before.optedInOnly - 1);
    expect(after.optedInAndCustomers).toBe(before.optedInAndCustomers - 1);
    const b = await draft("OPTED_IN_AND_CUSTOMERS");
    const started = await startBroadcast(b.id, after.optedInAndCustomers);
    expect(started.recipientCount).toBe(after.optedInAndCustomers);
    expect((await mineIn(b.id)).map((r) => r.email)).toEqual([keep.email]);
  });

  it("a customer whose ORDER address is opted out is left out; a customer with no opt-out anywhere stays", async () => {
    const orderAddress = addr("order");
    const gone = await makeUser({ order: "PAID" });
    await useAddresses(gone.id, addr("session"), orderAddress);
    const plain = await makeUser({ order: "PAID" });
    await optOut(orderAddress);
    expect(mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"))).toEqual([
      plain.email,
    ]);
  });

  it("a per-order stop (reminder B) removes nobody from a broadcast", async () => {
    const u = await makeUser({ consent: "yes", order: "DELIVERED" });
    const session = await prisma.orderSession.findFirstOrThrow({
      where: { userId: u.id },
    });
    await prisma.reminderStop.create({
      data: { kind: "BOOK_NOT_SENT", orderSessionId: session.id },
    });
    for (const audience of [
      "OPTED_IN_ONLY",
      "OPTED_IN_AND_CUSTOMERS",
    ] as const) {
      expect(mineOf(await resolveAudience(audience))).toEqual([u.email]);
    }
  });

  it("addresses are compared in lowercase", async () => {
    const other = addr("mixed");
    const gone = await makeUser({ order: "PAID" });
    await useAddresses(gone.id, other.toUpperCase());
    await optOut(other);
    expect(mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"))).toEqual([]);
  });

  it("at send time a customer who unsubscribes after the snapshot via another address is dropped, the rest are mailed", async () => {
    const other = addr("late");
    const late = await makeUser({ consent: "yes", order: "DELIVERED" });
    await useAddresses(late.id, other, addr("laterorder"));
    const keep = await makeUser({ consent: "yes", order: "DELIVERED" });
    const id = await startFor("OPTED_IN_AND_CUSTOMERS", [
      late.email,
      keep.email,
    ]);
    expect((await mineIn(id)).length).toBe(2);
    await optOut(other);
    await sweepBroadcasts(NOW);
    expect(sentTo()).toEqual([keep.email]);
    expect((await mineIn(id)).map((r) => r.email)).toEqual([keep.email]);

    // the same through the order's own address, with the capitals a stored address may have
    const orderOther = addr("lateorder");
    const late2 = await makeUser({ order: "PAID" });
    await useAddresses(late2.id, addr("s2"), orderOther.toUpperCase());
    await startFor("OPTED_IN_AND_CUSTOMERS", [late2.email]);
    await optOut(orderOther);
    fakes.send.mockClear();
    await sweepBroadcasts(new Date(NOW.getTime() + 24 * H));
    expect(sentTo()).toEqual([]);
  });
});

describe("draft, preview and test", () => {
  it("records who created it, merges updates, and refuses half a button", async () => {
    const b = await draft();
    expect(b.createdByEmail).toBe(`admin${DOMAIN}`);
    expect(b.status).toBe("DRAFT");
    const up = await updateBroadcast(b.id, { subject: "New" });
    expect(up.subject).toBe("New");
    expect(up.message).toBe("Hello there");
    await expect(updateBroadcast(b.id, { buttonText: "Go" })).rejects.toThrow(
      /both the button/
    );
    const withButton = await updateBroadcast(b.id, {
      buttonText: "Go",
      buttonUrl: "https://example.com",
    });
    expect(withButton.buttonUrl).toBe("https://example.com");
    await expect(updateBroadcast(b.id, { buttonUrl: null })).rejects.toThrow(
      /both the button/
    );
  });

  it("a draft can be deleted; a started one cannot be edited or deleted", async () => {
    const gone = await draft();
    await deleteBroadcastDraft(gone.id);
    await expect(getBroadcast(gone.id)).rejects.toThrow(/not found/);
    const u = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [u.email]);
    await expect(updateBroadcast(id, { subject: "x" })).rejects.toThrow(
      /already been started/
    );
    await expect(deleteBroadcastDraft(id)).rejects.toThrow(
      /already been started/
    );
  });

  it("preview renders the exact email; the test goes only to the admin's own address with a [Test] subject and no recipient row", async () => {
    const b = await draft("OPTED_IN_ONLY", { heading: "<b>Hi</b>" });
    const preview = await previewBroadcast(b.id);
    expect(preview.html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    expect(await sendTestBroadcast(b.id, ADMIN.email)).toEqual({ sent: true });
    expect(fakes.send).toHaveBeenCalledTimes(1);
    const call = fakes.send.mock.calls[0]![0];
    expect(call.to).toBe(`admin${DOMAIN}`);
    expect(call.subject).toBe("[Test] Diwali offer");
    expect(call.html).not.toMatch(/unsubscribe\?t=/);
    expect(
      await prisma.broadcastRecipient.count({ where: { broadcastId: b.id } })
    ).toBe(0);
    expect(
      await prisma.emailUnsubscribeToken.count({
        where: { email: `admin${DOMAIN}` },
      })
    ).toBe(0);
  });

  it("a refused test (development guard) says so and does not throw", async () => {
    const b = await draft();
    fakes.send.mockRejectedValue(new EmailGuardRefusal());
    const out = await sendTestBroadcast(b.id, ADMIN.email);
    expect(out.sent).toBe(false);
  });
});

describe("start", () => {
  it("refuses when the count the admin saw is not the count now, and starts nothing", async () => {
    await makeUser({ consent: "yes" });
    const b = await draft();
    const now = (await resolveAudience("OPTED_IN_ONLY")).length;
    await expect(startBroadcast(b.id, now + 1)).rejects.toThrow(
      /audience changed/
    );
    expect((await getBroadcast(b.id)).status).toBe("DRAFT");
    expect(
      await prisma.broadcastRecipient.count({ where: { broadcastId: b.id } })
    ).toBe(0);
  });

  it("takes a snapshot, goes to SENDING, and cannot be started twice", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await draft();
    const total = (await resolveAudience("OPTED_IN_ONLY")).length;
    const started = await startBroadcast(b.id, total);
    expect(started.status).toBe("SENDING");
    expect(started.recipientCount).toBe(total);
    expect(started.sendStartedAt).not.toBeNull();
    expect((await mineIn(b.id)).map((r) => r.email)).toEqual([a.email]);
    await expect(startBroadcast(b.id, total)).rejects.toThrow(
      /already been started/
    );
  });

  it("a later consent change does not alter the snapshot's size", async () => {
    await makeUser({ consent: "yes" });
    const b = await draft();
    const total = (await resolveAudience("OPTED_IN_ONLY")).length;
    await startBroadcast(b.id, total);
    await makeUser({ consent: "yes" });
    expect((await getBroadcast(b.id)).recipientCount).toBe(total);
  });
});

describe("sweep", () => {
  it("sends once to each recipient with the claim as idempotency key, a one-click header and a fresh token", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    expect(await sweepBroadcasts(NOW)).toBe(1);
    const call = fakes.send.mock.calls[0]![0];
    const row = (await mineIn(id))[0]!;
    expect(call.to).toBe(a.email);
    // a new key for every claim (not the recipient's id), so a given-back recipient is a new attempt
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.idempotencyKey).not.toBe(row.id);
    expect(call.subject).toBe("Diwali offer");
    expect(call.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click"
    );
    const token = call.headers["List-Unsubscribe"].match(
      /unsubscribe\/([^>]+)>/
    )![1];
    const stored = await prisma.emailUnsubscribeToken.findUnique({
      where: { token },
    });
    expect(stored).toMatchObject({
      email: a.email,
      scope: "GLOBAL",
      orderSessionId: null,
    });
    expect(call.html).toContain(`unsubscribe?t=${token}`);
    expect(call.html).toContain("because you chose to hear from Unilake");
    expect(row.status).toBe("SENT");
    // a second run sends nothing more, and the broadcast closes with its counts
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect(fakes.send).toHaveBeenCalledTimes(1);
    const done = await getBroadcast(id);
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(1);
    expect(done.finishedAt).not.toBeNull();
  });

  it("the footer for a customer who did not tick says they ordered", async () => {
    const c = await makeUser({ order: "DELIVERED" });
    await startFor("OPTED_IN_AND_CUSTOMERS", [c.email]);
    await sweepBroadcasts(NOW);
    expect(fakes.send.mock.calls[0]![0].html).toContain(
      "because you ordered from Unilake"
    );
  });

  it("sends nothing outside the send window, and nothing when the budget leaves no room after the reserve", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    expect(await sweepBroadcasts(new Date("2026-11-10T16:00:00.000Z"))).toBe(0); // 21:30 IST
    await settings({ dailyBudget: 10, reminderReserve: 10 });
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect(fakes.send).not.toHaveBeenCalled();
    expect((await mineIn(id))[0]!.status).toBe("PENDING");
  });

  it("the reserve is held for reminders until they use it, and shrinks the broadcast when they use more", async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser({ consent: "yes" }));
    const id = await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    await settings({ dailyBudget: 12, reminderReserve: 10 });
    expect(await sweepBroadcasts(NOW)).toBe(2); // 12 - max(10, 0) - 0
    // reminders have now used 11 of the day: 12 - 11 - 2 already sent = nothing left
    for (let i = 0; i < 11; i++) {
      await prisma.reminderSend.create({
        data: {
          kind: "PREVIEW_UNFINISHED",
          orderSessionId: `vtb-fake-${i}`,
          offsetHours: 3,
          email: addr("r"),
          status: "SENT",
          claimedAt: ago(1),
        },
      });
    }
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect((await mineIn(id)).filter((r) => r.status === "SENT")).toHaveLength(
      2
    );
  });

  it("when reminders have already used more than the reserve, the broadcast gets only what is truly left", async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await makeUser({ consent: "yes" }));
    await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    await settings({ dailyBudget: 12, reminderReserve: 10 });
    for (let i = 0; i < 11; i++) {
      await prisma.reminderSend.create({
        data: {
          kind: "PREVIEW_UNFINISHED",
          orderSessionId: `vtb-fake-over-${i}`,
          offsetHours: 3,
          email: addr("r"),
          status: "SENT",
          claimedAt: ago(1),
        },
      });
    }
    expect(await sweepBroadcasts(NOW)).toBe(1); // 12 - 11 used = 1, not 12 - 10 reserve = 2
  });

  it("the per-run limit applies, and one address is mailed once per run", async () => {
    const users = [];
    for (let i = 0; i < 5; i++) users.push(await makeUser({ consent: "yes" }));
    await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    await settings({ perRunLimit: 3 });
    expect(await sweepBroadcasts(NOW)).toBe(3);
    expect(await sweepBroadcasts(NOW)).toBe(2);
    expect(new Set(sentTo()).size).toBe(5);
  });

  it("an address mailed a reminder in the last 24 hours is skipped, stays pending, and does not stall the others", async () => {
    const held = await makeUser({ consent: "yes" });
    const free = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [held.email, free.email]);
    await prisma.reminderSend.create({
      data: {
        kind: "PREVIEW_UNFINISHED",
        orderSessionId: "vtb-fake-held",
        offsetHours: 3,
        email: held.email,
        status: "SENT",
        claimedAt: ago(5),
      },
    });
    await settings({ perRunLimit: 1 });
    expect(await sweepBroadcasts(NOW)).toBe(1);
    expect(sentTo()).toEqual([free.email]);
    const heldRow = (await mineIn(id)).find((r) => r.email === held.email)!;
    expect(heldRow.status).toBe("PENDING");
    // 25 hours after the reminder it goes
    expect(await sweepBroadcasts(new Date(NOW.getTime() + 20 * H))).toBe(0); // 07:30 IST next day: outside window
    expect(await sweepBroadcasts(new Date(NOW.getTime() + 24 * H))).toBe(1);
    expect(sentTo()).toEqual([free.email, held.email]);
  });

  it("anyone who opts out after the snapshot is dropped, and a withdrawn consent drops both audiences", async () => {
    const out = await makeUser({ consent: "yes" });
    const withdrew = await makeUser({ consent: "yes" });
    const keep = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [
      out.email,
      withdrew.email,
      keep.email,
    ]);
    await prisma.emailOptOut.create({ data: { email: out.email } });
    await prisma.marketingConsent.updateMany({
      where: { email: withdrew.email },
      data: { withdrawnAt: NOW },
    });
    await sweepBroadcasts(NOW);
    expect(sentTo()).toEqual([keep.email]);
    expect((await mineIn(id)).map((r) => r.email)).toEqual([keep.email]);

    // the wider audience also drops a customer who unticked the box after the snapshot, and never mails an
    // opted-out one; a customer who never ticked is still mailed
    const cust = await makeUser({ consent: "yes", order: "DELIVERED" });
    const plain = await makeUser({ order: "DELIVERED" });
    const optedOutCust = await makeUser({ order: "PAID" });
    await startFor("OPTED_IN_AND_CUSTOMERS", [
      cust.email,
      plain.email,
      optedOutCust.email,
    ]);
    await prisma.emailOptOut.create({ data: { email: optedOutCust.email } });
    await prisma.marketingConsent.updateMany({
      where: { email: cust.email },
      data: { withdrawnAt: NOW },
    });
    fakes.send.mockClear();
    await sweepBroadcasts(new Date(NOW.getTime() + 24 * H));
    expect(sentTo()).toEqual([plain.email]);
  });

  it("a cancelled broadcast sends nothing, and a cancel that lands mid-run stops the rest", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email, b.email]);
    let first = true;
    fakes.send.mockImplementation(async () => {
      if (first) {
        first = false;
        await cancelBroadcast(id);
      }
      return { messageId: `m-${++seq}` };
    });
    await sweepBroadcasts(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(1); // the second was claimed but re-checked and not sent
    const rows = await mineIn(id);
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
    expect((await getBroadcast(id)).status).toBe("CANCELLED");
    fakes.send.mockClear();
    await sweepBroadcasts(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
    await expect(cancelBroadcast(id)).rejects.toThrow(
      /already finished or been cancelled/
    );
  });
});

describe("what Resend and the guard answer", () => {
  it("a limit answer gives the claim back and stops the run", async () => {
    const users = [
      await makeUser({ consent: "yes" }),
      await makeUser({ consent: "yes" }),
    ];
    const id = await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    fakes.send.mockRejectedValue(
      new EmailSendError("limit (HTTP 429)", "daily_quota_exceeded", 429)
    );
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect(fakes.send).toHaveBeenCalledTimes(1);
    const rows = await mineIn(id);
    expect(
      rows.every((r) => r.status === "PENDING" && r.claimedAt === null)
    ).toBe(true);
  });

  it("a definite refusal marks only that recipient FAILED with the error name, never the address text", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email, b.email]);
    fakes.send.mockImplementationOnce(async () => {
      throw new EmailSendError(
        `secret ${a.email} (HTTP 422)`,
        "validation_error",
        422
      );
    });
    expect(await sweepBroadcasts(NOW)).toBe(1);
    const rows = await mineIn(id);
    const failed = rows.filter((r) => r.status === "FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.errorName).toBe("validation_error");
    expect(JSON.stringify(rows)).not.toContain("secret");
    const done = await getBroadcast(id);
    expect([done.status, done.sentCount, done.failedCount]).toEqual([
      "SENT",
      1,
      1,
    ]);
    expect(
      await prisma.emailOptOut.count({ where: { email: { endsWith: DOMAIN } } })
    ).toBe(0);
  });

  it("an unknown result stays claimed, counts toward the budget, is never resent, and does not hold the broadcast open after an hour", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    fakes.send.mockRejectedValue(new Error("socket hang up"));
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect((await mineIn(id))[0]!.status).toBe("CLAIMED");
    expect((await getBroadcast(id)).status).toBe("SENDING");
    fakes.send.mockClear();
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect(fakes.send).not.toHaveBeenCalled();
    await finalizeBroadcasts(new Date(NOW.getTime() + 2 * H));
    expect((await getBroadcast(id)).status).toBe("SENT");
  });

  it("a development-guard refusal marks the recipient FAILED so it cannot stall the ones behind it", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    fakes.send.mockRejectedValue(new EmailGuardRefusal());
    await sweepBroadcasts(NOW);
    const row = (await mineIn(id))[0]!;
    expect([row.status, row.errorName]).toEqual([
      "FAILED",
      "not_allowed_in_development",
    ]);
  });
});

describe("review round: verified addresses, setup errors, development limits", () => {
  it("a tick counts only for a verified address: the audience leaves out an unverified account", async () => {
    const real = await makeUser({ consent: "yes" });
    await makeUser({ consent: "yes", verified: false });
    expect(mineOf(await resolveAudience("OPTED_IN_ONLY"))).toEqual([
      real.email,
    ]);
  });

  it("a customer whose address is not verified, and a made-up social-login address, are not in the audience", async () => {
    const good = await makeUser({ order: "DELIVERED" });
    await makeUser({ order: "DELIVERED", verified: false });
    const fake = await makeUser({
      consent: "yes",
      rawEmail: () => `${++seq}@facebook.local`,
    });
    const audience = await resolveAudience("OPTED_IN_AND_CUSTOMERS");
    expect(mineOf(audience)).toEqual([good.email]);
    expect(audience.some((a) => a.endsWith("@facebook.local"))).toBe(false);
    expect(fake.id).toBeTruthy();
  });

  it("a recipient given back and claimed again is a new attempt with a new idempotency key", async () => {
    const a = await makeUser({ consent: "yes" });
    await startFor("OPTED_IN_ONLY", [a.email]);
    fakes.send.mockRejectedValueOnce(
      new EmailSendError("x (HTTP 403)", "validation_error", 403)
    );
    await sweepBroadcasts(NOW); // refused for a setup error: given back
    await sweepBroadcasts(NOW); // claimed again and sent
    expect(fakes.send).toHaveBeenCalledTimes(2);
    const [first, second] = fakes.send.mock.calls.map((c) => c[0]);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("three refusals in a row stop the run", async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser({ consent: "yes" }));
    const id = await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    fakes.send.mockRejectedValue(
      new EmailSendError("bad (HTTP 422)", "validation_error", 422)
    );
    await sweepBroadcasts(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(3);
    expect(
      (await mineIn(id)).filter((r) => r.status === "FAILED")
    ).toHaveLength(3);
  });

  it("a failure before the send gives the claim back", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    fakes.failLinks = 1;
    await sweepBroadcasts(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
    const row = (await mineIn(id))[0]!;
    expect([row.status, row.claimedAt]).toEqual(["PENDING", null]);
    expect(await sweepBroadcasts(NOW)).toBe(1);
  });

  it("an address that stops being verified after the snapshot is dropped at send time", async () => {
    const a = await makeUser({ consent: "yes" });
    await startFor("OPTED_IN_ONLY", [a.email]);
    await prisma.user.update({
      where: { id: a.id },
      data: { emailVerified: false },
    });
    await sweepBroadcasts(NOW);
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("a user stored with capitals is still found at send time", async () => {
    const a = await makeUser({
      consent: "yes",
      rawEmail: (e) => e.replace("u-", "U-"),
    });
    // the snapshot lowercases the address; the stored one has a capital
    await startFor("OPTED_IN_ONLY", [a.email.toLowerCase()]);
    await sweepBroadcasts(NOW);
    expect(sentTo()).toEqual([a.email.toLowerCase()]);
  });

  for (const status of [401, 403] as const) {
    it(`a setup error (HTTP ${status}) stops the run and gives the claims back: nobody is marked failed`, async () => {
      const users = [];
      for (let i = 0; i < 3; i++)
        users.push(await makeUser({ consent: "yes" }));
      const id = await startFor(
        "OPTED_IN_ONLY",
        users.map((u) => u.email)
      );
      fakes.send.mockRejectedValue(
        new EmailSendError(`x (HTTP ${status})`, "validation_error", status)
      );
      expect(await sweepBroadcasts(NOW)).toBe(0);
      expect(fakes.send).toHaveBeenCalledTimes(1);
      const rows = await mineIn(id);
      expect(
        rows.every((r) => r.status === "PENDING" && r.claimedAt === null)
      ).toBe(true);
      expect((await getBroadcast(id)).status).toBe("SENDING"); // not closed with everyone "failed"
    });
  }

  for (const [status, name, text] of [
    [400, "invalid_api_key", "API key is invalid"],
    [422, "invalid_from_address", "Invalid `from` field"],
    [422, "missing_required_field", "Missing `from` field"],
    [422, "validation_error", "Invalid `from` field. The email address needs"],
  ] as const) {
    it(`a setup error by name (HTTP ${status} ${name}, ${text}) stops the run and gives the claims back`, async () => {
      const users = [];
      for (let i = 0; i < 3; i++)
        users.push(await makeUser({ consent: "yes" }));
      const id = await startFor(
        "OPTED_IN_ONLY",
        users.map((u) => u.email)
      );
      fakes.send.mockRejectedValue(
        new EmailSendError(
          `Resend send failed: ${name}: ${text} (HTTP ${status})`,
          name,
          status
        )
      );
      expect(await sweepBroadcasts(NOW)).toBe(0);
      expect(fakes.send).toHaveBeenCalledTimes(1);
      expect(
        (await mineIn(id)).every(
          (r) => r.status === "PENDING" && r.claimedAt === null
        )
      ).toBe(true);
    });
  }

  it("a validation error about the recipient is a refusal of that one message, not a setup error", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email, b.email]);
    fakes.send.mockRejectedValueOnce(
      new EmailSendError(
        "Resend send failed: validation_error: Invalid `to` field (HTTP 422)",
        "validation_error",
        422
      )
    );
    expect(await sweepBroadcasts(NOW)).toBe(1);
    expect((await mineIn(id)).map((r) => r.status).sort()).toEqual([
      "FAILED",
      "SENT",
    ]);
  });

  it("a claim whose rows changed under it throws and rolls back: nothing stays claimed with no send", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email, b.email]);
    const realTransaction = prisma.$transaction.bind(prisma) as (
      fn: (tx: unknown) => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;
    // the claim's update runs for real inside the transaction, but reports one row too few
    const client = prisma as unknown as { $transaction: unknown };
    const original = client.$transaction;
    client.$transaction = ((
      fn: (tx: unknown) => Promise<unknown>,
      options?: unknown
    ) =>
      realTransaction(
        (tx) =>
          fn(
            new Proxy(tx as object, {
              get: (target, key) => {
                const value = Reflect.get(target, key) as object;
                if (key !== "broadcastRecipient") return value;
                return new Proxy(value, {
                  get: (model, method) =>
                    method === "updateMany"
                      ? async (args: unknown) => {
                          const real = await (
                            model as {
                              updateMany: (a: unknown) => Promise<{
                                count: number;
                              }>;
                            }
                          ).updateMany(args);
                          return { count: real.count - 1 };
                        }
                      : (...args: unknown[]) =>
                          (
                            Reflect.get(model, method) as (
                              ...a: unknown[]
                            ) => unknown
                          ).apply(model, args),
                });
              },
            })
          ),
        options
      )) as never;
    try {
      await expect(sweepBroadcasts(NOW)).rejects.toThrow(
        /Claim count mismatch/
      );
    } finally {
      client.$transaction = original;
    }
    expect(fakes.send).not.toHaveBeenCalled();
    expect(
      (await mineIn(id)).every(
        (r) => r.status === "PENDING" && r.claimedAt === null
      )
    ).toBe(true);
    expect(await sweepBroadcasts(NOW)).toBe(2); // the next run claims and sends normally
  });

  it("an idempotency conflict (HTTP 409) is not a failure", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    fakes.send.mockRejectedValue(
      new EmailSendError(
        "conflict (HTTP 409)",
        "concurrent_idempotent_requests",
        409
      )
    );
    await sweepBroadcasts(NOW);
    expect((await mineIn(id))[0]!.status).toBe("CLAIMED");
  });

  it("several sends in a row with no answer stop the run", async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser({ consent: "yes" }));
    await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    fakes.send.mockRejectedValue(new Error("socket hang up"));
    await sweepBroadcasts(NOW);
    expect(fakes.send).toHaveBeenCalledTimes(3);
  });

  it("outside production, addresses off the allow-list stay out of the look-ahead and cannot stall the allowed one", async () => {
    const blocked = [];
    for (let i = 0; i < 6; i++)
      blocked.push(await makeUser({ consent: "yes" }));
    const mine = await makeUser({ consent: "yes" });
    await startFor("OPTED_IN_ONLY", [
      ...blocked.map((u) => u.email),
      mine.email,
    ]);
    await settings({ perRunLimit: 1 });
    fakes.allowed = [mine.email];
    await sweepBroadcasts(NOW);
    expect(sentTo()).toEqual([mine.email]);
  });
});

describe("review round 3: trusted addresses and capacity", () => {
  it("a social sign-in counts as the person's own address even when the account is not marked verified; email and password does not", async () => {
    const facebook = await makeUser({
      consent: "yes",
      verified: false,
      provider: "facebook",
    });
    const google = await makeUser({
      consent: "yes",
      verified: false,
      provider: "google",
    });
    await makeUser({ consent: "yes", verified: false }); // email and password, never verified
    expect(mineOf(await resolveAudience("OPTED_IN_ONLY")).sort()).toEqual(
      [facebook.email, google.email].sort()
    );
    const customer = await makeUser({
      order: "DELIVERED",
      verified: false,
      provider: "facebook",
    });
    expect(mineOf(await resolveAudience("OPTED_IN_AND_CUSTOMERS"))).toContain(
      customer.email
    );
  });

  it("and at send time the same rule applies", async () => {
    const facebook = await makeUser({
      consent: "yes",
      verified: false,
      provider: "facebook",
    });
    await startFor("OPTED_IN_ONLY", [facebook.email]);
    expect(await sweepBroadcasts(NOW)).toBe(1);
  });

  it("the audience counts say what a broadcast may send in a day", async () => {
    await settings({ dailyBudget: 30, reminderReserve: 10 });
    expect((await getAudienceCounts()).dailyCapacity).toBe(20);
    await settings({ dailyBudget: 10, reminderReserve: 10 });
    expect((await getAudienceCounts()).dailyCapacity).toBe(0);
  });

  it("a broadcast that cannot finish before it would be cancelled is refused, with the reason, and nothing starts", async () => {
    await settings({ dailyBudget: 11, reminderReserve: 10 }); // room for 1 a day: 7 days, 7 people at most
    const users = [];
    for (let i = 0; i < 8; i++) users.push(await makeUser({ consent: "yes" }));
    const b = await draft();
    const total = (await resolveAudience("OPTED_IN_ONLY")).length;
    await expect(startBroadcast(b.id, total)).rejects.toThrow(/about 8 days/);
    expect((await getBroadcast(b.id)).status).toBe("DRAFT");
    // one fewer fits
    await prisma.marketingConsent.updateMany({
      where: { userId: users[0]!.id },
      data: { withdrawnAt: NOW },
    });
    const fewer = (await resolveAudience("OPTED_IN_ONLY")).length;
    expect((await startBroadcast(b.id, fewer)).status).toBe("SENDING");
  });

  it("with no room in the budget at all, it says so", async () => {
    await settings({ dailyBudget: 10, reminderReserve: 10 });
    await makeUser({ consent: "yes" });
    const b = await draft();
    const total = (await resolveAudience("OPTED_IN_ONLY")).length;
    await expect(startBroadcast(b.id, total)).rejects.toThrow(/no room/);
  });
});

describe("limits and housekeeping", () => {
  it("a broadcast still sending after seven days is cancelled", async () => {
    const a = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email]);
    await prisma.broadcast.update({
      where: { id },
      data: { sendStartedAt: ago(8 * 24) },
    });
    await finalizeBroadcasts(NOW);
    expect((await getBroadcast(id)).status).toBe("CANCELLED");
    expect(await sweepBroadcasts(NOW)).toBe(0);
    expect(fakes.send).not.toHaveBeenCalled();
  });

  it("two overlapping claims never take the same recipient", async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await makeUser({ consent: "yes" }));
    await startFor(
      "OPTED_IN_ONLY",
      users.map((u) => u.email)
    );
    const s = await getReminderSettings();
    const [x, y] = await Promise.all([
      claimBroadcastBatch(s, NOW),
      claimBroadcastBatch(s, NOW),
    ]);
    const ids = [...x, ...y].map((c) => c.recipientId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(mineOf([...x, ...y].map((c) => c.email)).length).toBe(6);
  });

  it("a budget of reserve plus one leaves room for exactly one send", async () => {
    const a = await makeUser({ consent: "yes" });
    await startFor("OPTED_IN_ONLY", [a.email]);
    await settings({ dailyBudget: 11, reminderReserve: 10 }); // room for one a day
    expect(await sweepBroadcasts(NOW)).toBe(1);
  });
});

describe("review round 4: retention", () => {
  it("recipient rows older than 90 days are purged with the send logs, newer ones are kept", async () => {
    const a = await makeUser({ consent: "yes" });
    const b = await makeUser({ consent: "yes" });
    const id = await startFor("OPTED_IN_ONLY", [a.email, b.email]);
    const old = new Date(NOW.getTime() - 91 * 24 * H);
    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: id, email: a.email },
      data: { createdAt: old },
    });
    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: id, email: b.email },
      data: { createdAt: new Date(NOW.getTime() - 89 * 24 * H) },
    });
    await purgeOldEmailRows(NOW);
    expect((await mineIn(id)).map((r) => r.email)).toEqual([b.email]);
  });
});
