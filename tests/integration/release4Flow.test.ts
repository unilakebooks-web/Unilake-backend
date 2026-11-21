// Release 4, the three features together (reminder emails, automatic data deletion, sharing): one customer's book
// walked through all three on the Neon TEST branch and local MinIO. Each feature has its own test files; this file
// only checks what happens where they meet: a share must die with the files it points at, a reminder must never
// follow a deletion, a deleted preview must never reach a payment window, and a paid book's share must survive the
// photo deletion (D-115) but not the page deletion.
//
// Seams: the reminder sweep runs with a fake sender (nothing can be mailed), the deletion engine runs through
// sweepDataDeletion with an injected clock, scoped to this file's own comic (the engine scans the whole database
// otherwise), with a Razorpay stub that says "no payment". Every clock is in June 2031, far from any row another
// test leaves behind, and every session expires in 2031, so the real clock (used by checkout and the session
// snapshot) still sees the sessions as alive: only the deletion markers can refuse them there.
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

const fakes = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../src/lib/email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email.js")>()),
  sendEmail: fakes.send,
  isRecipientAllowed: () => true,
  devAllowedRecipients: () => null,
}));
const { addBulk, rzpCreate } = vi.hoisted(() => ({
  addBulk: vi.fn(async () => []),
  rzpCreate: vi.fn(),
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

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import { countPrefix, deletePrefix, uploadFile } from "../../src/lib/r2.js";
import { sweepReminders } from "../../src/services/reminder.service.js";
import { sweepDataDeletion } from "../../src/services/dataDeletion.service.js";
import type { DeletionDeps } from "../../src/services/dataDeletionEngine.service.js";
import {
  createOrGetShare,
  getShareState,
  getSharedBook,
  resolveSharedImageKey,
} from "../../src/services/share.service.js";
import { initiateCheckout } from "../../src/services/checkout.service.js";
import { getOrderSessionId } from "../../src/services/session.service.js";
import { NotFoundError } from "../../src/utils/errors.js";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";

const MARK = "__vitest_release4_flow__";
const RUN = Math.random().toString(36).slice(2, 8);
const DOMAIN = `@vitest-r4-${RUN}.test`;
const H = 3600_000;
const DAY = 24 * H;
const LONG = 150_000;
// 06:00 UTC is 11:30 IST, inside the reminders' 9:00 to 20:00 sending window; every sweep clock below is a whole
// number of days after this plus 0 or 6 hours, so it stays in the window.
const T0 = new Date("2031-06-15T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

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
const engine = (now: Date): DeletionDeps => ({
  now: () => now,
  rzp,
  onlyComicId: comicId,
});

let comicId = "";
let controlComicId = "";
let pageId = "";
const sessionIds: string[] = [];
const publicBase = () => config.r2.publicUrlBase.replace(/\/$/, "");

const sentTo = () => fakes.send.mock.calls.map((c) => c[0].to as string);

async function reminderSettings(over: Record<string, unknown>) {
  const base = {
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
  await prisma.reminderSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...base, ...over },
    update: { ...base, ...over },
  });
}

async function setMode(
  group: "PREVIEWS" | "PHOTOS" | "BOOKS",
  mode: "OFF" | "ACTIVE"
) {
  await prisma.deletionGroupSetting.update({
    where: { group },
    data: {
      mode,
      modeChangedAt: at(-10 * DAY),
      approvedSelectionVersion: SELECTION_VERSION[group],
      approvedRunId: null,
      approvedAt: mode === "ACTIVE" ? at(-DAY) : null,
      approvalExhaustedAt: mode === "ACTIVE" ? at(-DAY) : null,
      pausedReason: null,
      pausedAt: null,
      dailyMax: 100,
      lastReportAt: null,
    },
  });
}

interface MadeBook {
  id: string;
  orderId: string | null;
  razorpayOrderId: string | null;
  email: string;
  photoKey: string;
  pageKey: string;
}

/**
 * A session with a real photo (private bucket), a real web page image (public bucket, under final/ as the share
 * requires), one SD_READY page version and the session's page row, so a share has a page to show.
 */
async function makeBook(
  comic: string,
  label: string,
  o: {
    status: "PREVIEW_READY" | "COMPLETED";
    expiresAt: Date;
    order?: { status: "CREATED" | "DELIVERED"; deliveredAt?: Date };
  }
): Promise<MadeBook> {
  const email = `${label}${DOMAIN}`;
  const session = await prisma.orderSession.create({
    data: {
      comicId: comic,
      status: o.status,
      createdAt: T0,
      updatedAt: T0,
      expiresAt: o.expiresAt,
      notificationEmail: email,
      childName: "Aarav",
      rawPhotoUrls: [],
    },
  });
  sessionIds.push(session.id);
  const photoKey = `sessions/${session.id}/photo-1.jpg`;
  await uploadFile("private", photoKey, Buffer.from("photo"), "image/jpeg");
  await prisma.orderSession.update({
    where: { id: session.id },
    data: { bestPhotoUrl: photoKey, rawPhotoUrls: [photoKey] },
  });
  const versionId = crypto.randomUUID();
  const pageKey = `sessions/${session.id}/final/${versionId}.webp`;
  await uploadFile("public", pageKey, Buffer.from("page"), "image/webp");
  await prisma.pageVersion.create({
    data: {
      id: versionId,
      orderSessionId: session.id,
      pageId,
      variantIndex: 0,
      status: "SD_READY",
      displayImageUrl: `${publicBase()}/${pageKey}`,
      finalImageUrl: `${publicBase()}/sessions/${session.id}/final/${versionId}.png`,
    },
  });
  await prisma.sessionPage.create({
    data: { orderSessionId: session.id, pageId, isPreviewPage: true },
  });
  let orderId: string | null = null;
  let razorpayOrderId: string | null = null;
  if (o.order) {
    razorpayOrderId = `order_${RUN}_${session.id.slice(0, 8)}`;
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: o.order.status,
        razorpayOrderId,
        razorpayPaymentId:
          o.order.status === "CREATED" ? null : `pay_${RUN}_${label}`,
        billNumber:
          o.order.status === "CREATED" ? null : `BILL-${RUN}-${label}`,
        deliveredAt: o.order.deliveredAt ?? null,
        shippingName: `${MARK} ${RUN}`,
        notificationEmail: o.order.status === "CREATED" ? null : email,
      },
    });
    orderId = order.id;
  }
  return { id: session.id, orderId, razorpayOrderId, email, photoKey, pageKey };
}

const markers = (id: string) =>
  prisma.orderSession.findUniqueOrThrow({
    where: { id },
    select: { photoDeletedAt: true, filesDeletedAt: true },
  });

async function wipe() {
  const found = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  const ids = [...new Set([...sessionIds, ...found.map((s) => s.id)])];
  sessionIds.length = 0;
  for (const id of ids) {
    await deletePrefix("public", `sessions/${id}/`).catch(() => 0);
    await deletePrefix("private", `sessions/${id}/`).catch(() => 0);
  }
  await prisma.reminderStop.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.reminderSend.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.emailUnsubscribeToken.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.deletionItem.deleteMany({ where: { subjectId: { in: ids } } });
  await prisma.sessionShare.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
}

async function cleanup() {
  await wipe();
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

async function restoreSettings() {
  await reminderSettings({});
  for (const g of ["PREVIEWS", "PHOTOS", "BOOKS"] as const) {
    await prisma.deletionGroupSetting.update({
      where: { group: g },
      data: {
        mode: "REPORT_ONLY",
        approvedRunId: null,
        approvedAt: null,
        approvalExhaustedAt: null,
        pausedReason: null,
        pausedAt: null,
      },
    });
  }
}

beforeAll(async () => {
  await cleanup();
  comicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} Pirate Island ${RUN}`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
        coverThumbnailUrls: ["https://img.example.test/pirate.webp"],
      },
    })
  ).id;
  // A second comic the deletion engine is NOT scoped to: its session is the control that shows a reminder sweep
  // would have sent, so a missing mail is the deletion marker and nothing else.
  controlComicId = (
    await prisma.comic.create({
      data: {
        title: `${MARK} Control ${RUN}`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    })
  ).id;
  pageId = (
    await prisma.page.create({
      data: {
        comicId,
        pageNumber: 1,
        hasFace: true,
        artworkUrl: "https://example.test/a.png",
        isPreviewPage: true,
      },
    })
  ).id;
});

beforeEach(async () => {
  fakes.send
    .mockReset()
    .mockImplementation(async () => ({ messageId: `m-${Math.random()}` }));
  rzp.fetchPayments.mockClear();
  rzpCreate.mockReset();
  await prisma.deletionRun.deleteMany({});
  await prisma.deletionBlock.deleteMany({});
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: at(60 * DAY), leaseUntil: null, leaseOwner: null },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.deletionRun.deleteMany({});
  await restoreSettings();
  await prisma.$disconnect();
});

describe("scenario 1: an unpaid preview is shared, reminded, then deleted", () => {
  let book: MadeBook;
  let token = "";
  let remindersBeforeDeletion = 0;

  beforeAll(async () => {
    await wipe();
    // The expiry is 7 days after creation (the preview's lifetime); the unpaid order is the "payment window opened
    // and left" case, old enough (real updatedAt is 2026) for the deletion's two-day settle rule.
    book = await makeBook(comicId, "preview", {
      status: "PREVIEW_READY",
      expiresAt: at(7 * DAY),
      order: { status: "CREATED" },
    });
    await setMode("PREVIEWS", "ACTIVE");
    await setMode("PHOTOS", "OFF");
    await setMode("BOOKS", "OFF");
    // A 3 hour first reminder and a 6 day (the largest allowed) second one.
    await reminderSettings({
      previewEnabled: true,
      previewEffectiveFrom: at(-1000 * H),
      previewOffsetsHours: [3, 144],
    });
  }, LONG);

  it(
    "step 1 and 2: the preview is alive with its files, and the customer shares it: pages and the image key resolve",
    async () => {
      expect(await markers(book.id)).toEqual({
        photoDeletedAt: null,
        filesDeletedAt: null,
      });
      expect(await countPrefix("private", `sessions/${book.id}/`)).toBe(1);
      expect(await countPrefix("public", `sessions/${book.id}/`)).toBe(1);

      const share = await createOrGetShare(book.id, undefined, at(H));
      token = share.token;
      // The token shape the service creates is the one the share config accepts (32 characters of base64url).
      expect(token).toHaveLength(32);
      expect((await getShareState(book.id, at(H))).available).toBe(true);
      const shared = await getSharedBook(token, at(H));
      expect(shared.pages).toEqual([{ pageNumber: 1 }]);
      expect(shared.ready).toBe(true);
      expect(await resolveSharedImageKey(token, 1, at(H))).toBe(book.pageKey);
    },
    LONG
  );

  it(
    "step 3: the reminder sweep sends reminder A for it, while the preview still has all its files",
    async () => {
      expect(await sweepReminders(at(6 * H))).toBe(1);
      expect(sentTo()).toEqual([book.email]);
      remindersBeforeDeletion = fakes.send.mock.calls.length;
      const rows = await prisma.reminderSend.findMany({
        where: { orderSessionId: book.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "PREVIEW_UNFINISHED",
        offsetHours: 3,
        status: "SENT",
      });
      // Nothing was deleted at the moment the mail went out.
      expect(await markers(book.id)).toEqual({
        photoDeletedAt: null,
        filesDeletedAt: null,
      });
      expect(await countPrefix("private", `sessions/${book.id}/`)).toBe(1);
      expect(await countPrefix("public", `sessions/${book.id}/`)).toBe(1);
    },
    LONG
  );

  it(
    "step 4: the deletion engine claims and deletes the preview after the 7-day rule, through its own claim path, with Razorpay saying no payment",
    async () => {
      // One hour before expiry + 1 hour: nothing is due yet.
      await sweepDataDeletion(engine(at(7 * DAY)));
      expect(await markers(book.id)).toEqual({
        photoDeletedAt: null,
        filesDeletedAt: null,
      });
      expect(await countPrefix("private", `sessions/${book.id}/`)).toBe(1);

      await sweepDataDeletion(engine(at(7 * DAY + 2 * H)));
      const m = await markers(book.id);
      expect(m.photoDeletedAt).not.toBeNull();
      expect(m.filesDeletedAt).not.toBeNull();
      expect(await countPrefix("private", `sessions/${book.id}/`)).toBe(0);
      expect(await countPrefix("public", `sessions/${book.id}/`)).toBe(0);
      const item = await prisma.deletionItem.findUniqueOrThrow({
        where: {
          subjectId_scope: { subjectId: book.id, scope: "SESSION" },
        },
      });
      expect(item.state).toBe("DONE");
      // The unpaid order made the engine ask Razorpay; the stub's answer was "no payment".
      expect(rzp.fetchPayments).toHaveBeenCalledWith(book.razorpayOrderId);
      // The sweep is not the reminders' sweep: it mailed nobody.
      expect(fakes.send).not.toHaveBeenCalled();
      expect(remindersBeforeDeletion).toBe(1);
    },
    LONG
  );

  it(
    "step 5: afterwards the share is gone, no reminder follows, checkout is refused and the snapshot says the files are deleted",
    async () => {
      const after = at(7 * DAY + 2 * H);
      // The share: not found for the viewer, no image key, and the customer's Share button is not offered.
      await expect(getSharedBook(token, after)).rejects.toBeInstanceOf(
        NotFoundError
      );
      // Even with the preview's expiry still in the future (the real clock): the marker alone ends the share.
      await expect(getSharedBook(token)).rejects.toBeInstanceOf(NotFoundError);
      expect(await resolveSharedImageKey(token, 1, after)).toBeNull();
      expect(await resolveSharedImageKey(token, 1)).toBeNull();
      expect(await getShareState(book.id, after)).toEqual({
        available: false,
        active: false,
        token: null,
        showName: false,
      });
      // A new link cannot be made for a deleted preview either.
      await expect(
        createOrGetShare(book.id, undefined, after)
      ).rejects.toBeInstanceOf(NotFoundError);

      // Reminders: a control preview (same age, same settings, another comic the engine never touched, so it is
      // intact) gets the 6-day reminder at this clock; the deleted one, whose expiry is still a day away at this
      // clock, gets nothing. Only the deletion marker explains the difference.
      const control = await makeBook(controlComicId, "control", {
        status: "PREVIEW_READY",
        expiresAt: at(7 * DAY),
      });
      expect(await sweepReminders(at(6 * DAY + 6 * H))).toBe(1);
      expect(sentTo()).toEqual([control.email]);
      expect(sentTo()).not.toContain(book.email);
      // And a plain later sweep, after the expiry too: still nothing for the deleted preview.
      fakes.send.mockClear();
      expect(await sweepReminders(at(7 * DAY + 6 * H))).toBe(0);
      expect(fakes.send).not.toHaveBeenCalled();
      // Only the one reminder ever went to the deleted preview's address.
      expect(
        await prisma.reminderSend.count({
          where: { orderSessionId: book.id },
        })
      ).toBe(1);

      // Checkout: refused before any payment window (the session is not expired by the real clock; the marker
      // alone refuses it), and no Razorpay order is created.
      await expect(initiateCheckout(book.id, {})).rejects.toMatchObject({
        code: "PREVIEW_DELETED",
      });
      expect(rzpCreate).not.toHaveBeenCalled();

      // The customer's snapshot.
      const snap = await getOrderSessionId(book.id);
      expect(snap.isExpired).toBe(true);
      expect(snap.photoDeleted).toBe(true);
      expect(snap.filesDeleted).toBe(true);
    },
    LONG
  );
});

describe("scenario 2: a paid delivered book keeps its share until its pages are deleted", () => {
  let book: MadeBook;
  let token = "";
  const photoRule = at(3 * DAY + 2 * H); // 3 days + the 1 hour margin after delivery
  const pagesRule = at(45 * DAY + 2 * H);

  beforeAll(async () => {
    await wipe();
    book = await makeBook(comicId, "paid", {
      status: "COMPLETED",
      expiresAt: at(-30 * DAY),
      order: { status: "DELIVERED", deliveredAt: T0 },
    });
    await setMode("PREVIEWS", "OFF");
    await setMode("PHOTOS", "ACTIVE");
    await setMode("BOOKS", "ACTIVE");
    // C is selected by the order's delivery date; the 7 day offset first.
    await reminderSettings({
      reviewEnabled: true,
      reviewEffectiveFrom: at(-1000 * H),
      googleReviewUrl: "https://g.page/r/test/review",
      reviewOffsetsHours: [168],
    });
  }, LONG);

  it(
    "the share is live, then only the photo is deleted (3 days): the share, its pages and its image key stay (D-115)",
    async () => {
      token = (await createOrGetShare(book.id, undefined, at(DAY))).token;
      await sweepDataDeletion(engine(photoRule));
      const m = await markers(book.id);
      expect(m.photoDeletedAt).not.toBeNull();
      expect(m.filesDeletedAt).toBeNull();
      expect(await countPrefix("private", `sessions/${book.id}/`)).toBe(0);
      expect(await countPrefix("public", `sessions/${book.id}/`)).toBe(1);

      expect(await getShareState(book.id, photoRule)).toMatchObject({
        available: true,
        active: true,
        token,
      });
      const shared = await getSharedBook(token, photoRule);
      expect(shared.pages).toEqual([{ pageNumber: 1 }]);
      expect(await resolveSharedImageKey(token, 1, photoRule)).toBe(
        book.pageKey
      );
    },
    LONG
  );

  it(
    "reminder C (7 days after delivery) is still sent for a book whose photo is already deleted",
    async () => {
      expect(await sweepReminders(at(7 * DAY + 6 * H))).toBe(1);
      expect(sentTo()).toEqual([book.email]);
      const rows = await prisma.reminderSend.findMany({
        where: { orderSessionId: book.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "REVIEW_REQUEST",
        offsetHours: 168,
        status: "SENT",
      });
    },
    LONG
  );

  it(
    "when the pages are deleted (45 days) the share is gone, and reminder C selection is still unaffected by the marker",
    async () => {
      await sweepDataDeletion(engine(pagesRule));
      const m = await markers(book.id);
      expect(m.photoDeletedAt).not.toBeNull();
      expect(m.filesDeletedAt).not.toBeNull();
      expect(await countPrefix("public", `sessions/${book.id}/`)).toBe(0);

      await expect(getSharedBook(token, pagesRule)).rejects.toBeInstanceOf(
        NotFoundError
      );
      expect(await resolveSharedImageKey(token, 1, pagesRule)).toBeNull();
      expect((await getShareState(book.id, pagesRule)).available).toBe(false);

      // C's largest offset is 40 days, inside the 45: a 40 day reminder is selected for the order even with
      // both markers set (clock chosen at the 40 day mark to isolate the marker; the markers are on the row).
      fakes.send.mockClear();
      await reminderSettings({
        reviewEnabled: true,
        reviewEffectiveFrom: at(-1000 * H),
        googleReviewUrl: "https://g.page/r/test/review",
        reviewOffsetsHours: [960],
      });
      expect(await sweepReminders(at(40 * DAY + 6 * H))).toBe(1);
      expect(sentTo()).toEqual([book.email]);
    },
    LONG
  );
});
