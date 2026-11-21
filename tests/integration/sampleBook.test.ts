// Integration tests for the admin sample book (feature 2): creation and its limits, the refusals on
// the customer routes, discard, the PDF and the cleanup sweep. They run against the Neon TEST
// branch and the local MinIO bucket only (the setup import refuses anything else). The job queue and
// Razorpay are replaced by stubs, so nothing reaches Redis or a real service.
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
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

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
import {
  downloadFileToBuffer,
  deletePrefix,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  buildSamplePdf,
  createSample,
  discardSample,
  listSamples,
} from "../../src/services/sampleBook.service.js";
import {
  attachUserToSession,
  sendToPrint,
  triggerGeneration,
  updateOrderSession,
} from "../../src/services/session.service.js";
import { initiateCheckout } from "../../src/services/checkout.service.js";
import { deleteComic } from "../../src/services/comic.service.js";
import { reorderComicPages } from "../../src/services/page.service.js";
import {
  listCouponOffers,
  previewCoupon,
} from "../../src/services/couponCheckout.service.js";
import { sweepSampleSessions } from "../../src/jobs/workers/sampleSweeper.js";
import {
  MAX_LIVE_SAMPLES_OVERALL,
  MAX_LIVE_SAMPLES_PER_ADMIN,
  SAMPLE_CLEANUP_MARGIN_MS,
  SAMPLE_REFUSAL_MESSAGE,
  SAMPLE_TTL_MS,
} from "../../src/config/sample.js";
import type { PageVersionStatus } from "../../src/generated/prisma/client.js";

const MARK = "__vitest_sample__";
const RUN = Math.random().toString(36).slice(2, 8);

const userIds: string[] = [];
const keysToDelete = new Set<string>(); // session ids whose folders may hold files

let comicId: string;
let draftPageIds: string[] = [];
let otherComicPageId: string;
let admin: string;
let otherAdmin: string;
let thirdAdmin: string;

async function makeUser(label: string): Promise<string> {
  const id = `${MARK}-${RUN}-${label}`;
  await prisma.user.create({
    data: { id, name: "Vitest", email: `${id}@example.test` },
  });
  userIds.push(id);
  return id;
}

const input = (pageIds: string[], extra: object = {}) => ({
  comicId,
  childName: "Test",
  age: 6,
  pronounKey: "SHE" as const,
  pageIds,
  ...extra,
});

async function pngBytes(width = 40): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height: 60,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer();
}

/** A finished page version whose image really exists in the local bucket. */
async function finishedVersion(
  sessionId: string,
  pageId: string,
  status: PageVersionStatus = "SD_READY",
  width = 40
) {
  const key = `sessions/${sessionId}/final-${pageId}.png`;
  await uploadFile("public", key, await pngBytes(width), "image/png");
  keysToDelete.add(sessionId);
  return prisma.pageVersion.create({
    data: {
      orderSessionId: sessionId,
      pageId,
      variantIndex: 0,
      status,
      finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
    },
  });
}

async function cleanup() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  for (const { id } of sessions) keysToDelete.add(id);
  for (const id of keysToDelete) {
    await deletePrefix("public", `sessions/${id}/`);
    await deletePrefix("private", `sessions/${id}/`);
  }
  await prisma.order.deleteMany({
    where: { shippingName: { startsWith: MARK } },
  });
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  admin = await makeUser("admin");
  otherAdmin = await makeUser("admin2");
  thirdAdmin = await makeUser("admin3");
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} draft`,
      pageCount: 14,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicId = comic.id;
  for (let n = 1; n <= 14; n++) {
    const page = await prisma.page.create({
      data: {
        artworkUrl: "https://example.test/art.png",
        artworkWidth: 100,
        artworkHeight: 140,
        comicId,
        pageNumber: n,
        isPreviewPage: n === 1,
      },
    });
    draftPageIds.push(page.id);
  }
  const other = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} other`,
      pageCount: 1,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  otherComicPageId = (
    await prisma.page.create({
      data: {
        artworkUrl: "https://example.test/art.png",
        artworkWidth: 100,
        artworkHeight: 140,
        comicId: other.id,
        pageNumber: 1,
        isPreviewPage: true,
      },
    })
  ).id;
});

// Every test starts with no sample of ours, so the limits count from zero.
beforeEach(async () => {
  addBulk.mockClear();
  rzpCreate.mockReset();
  const sessions = await prisma.orderSession.findMany({
    where: { isSample: true, comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  for (const { id } of sessions) {
    await deletePrefix("public", `sessions/${id}/`);
    await deletePrefix("private", `sessions/${id}/`);
  }
  await prisma.order.deleteMany({
    where: { shippingName: { startsWith: MARK } },
  });
  await prisma.orderSession.deleteMany({
    where: { isSample: true, comic: { title: { startsWith: MARK } } },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createSample", () => {
  it("makes a flagged session of an unpublished comic with only the chosen pages, all free", async () => {
    const chosen = [draftPageIds[2]!, draftPageIds[5]!];
    const session = await createSample(input(chosen), admin);
    const row = await prisma.orderSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { sessionPages: true },
    });
    expect(row.isSample).toBe(true);
    expect(row.userId).toBe(admin);
    expect(row.notificationEmail).toBeNull();
    expect(row.childName).toBe("Test");
    expect(row.age).toBe(6);
    expect(row.pronounKey).toBe("SHE");
    expect(row.status).toBe("CREATED");
    expect(row.sessionPages.map((p) => p.pageId).sort()).toEqual(
      [...chosen].sort()
    );
    expect(row.sessionPages.every((p) => p.isPreviewPage)).toBe(true);
    const life = row.expiresAt.getTime() - Date.now();
    expect(life).toBeGreaterThan(SAMPLE_TTL_MS - 60_000);
    expect(life).toBeLessThanOrEqual(SAMPLE_TTL_MS);
  });

  it("an ordinary session is not a sample", async () => {
    const s = await prisma.orderSession.create({
      data: { comicId, expiresAt: new Date(Date.now() + 1000) },
    });
    expect(s.isSample).toBe(false);
  });

  it("refuses a page of another comic, a repeated page and more than 100 pages", async () => {
    await expect(
      createSample(input([otherComicPageId]), admin)
    ).rejects.toThrow(/belong to this comic/);
    await expect(
      createSample(input([draftPageIds[0]!, draftPageIds[0]!]), admin)
    ).rejects.toThrow(/only once/);
    await expect(
      createSample(
        input(Array.from({ length: 101 }, () => randomUUID())),
        admin
      )
    ).rejects.toThrow(/at most 100/);
    // More than the old limit of 12 is allowed: the admin may choose the whole book.
    const whole = await createSample(input(draftPageIds), admin);
    expect(
      await prisma.sessionPage.count({ where: { orderSessionId: whole.id } })
    ).toBe(draftPageIds.length);
  });

  it("refuses a page that has no artwork yet", async () => {
    const bare = await prisma.page.create({
      data: { comicId, pageNumber: 99, isPreviewPage: true },
    });
    await expect(createSample(input([bare.id]), admin)).rejects.toThrow(
      /Page 99 has no artwork/
    );
    await prisma.page.delete({ where: { id: bare.id } });
  });

  it("refuses a face page without its mask or prompt, and takes one that has both", async () => {
    const face = await prisma.page.create({
      data: {
        comicId,
        pageNumber: 98,
        isPreviewPage: true,
        hasFace: true,
        artworkUrl: "https://example.test/art.png",
        artworkWidth: 100,
        artworkHeight: 140,
      },
    });
    await expect(createSample(input([face.id]), admin)).rejects.toThrow(
      /Page 98 is a face page without its mask or prompt/
    );
    await prisma.page.update({
      where: { id: face.id },
      data: { maskUrl: "https://example.test/mask.png" },
    });
    await expect(createSample(input([face.id]), admin)).rejects.toThrow(
      /without its mask or prompt/
    );
    await prisma.page.update({
      where: { id: face.id },
      data: { pagePrompt: "a child on a ship" },
    });
    const made = await createSample(input([face.id]), admin);
    expect(
      await prisma.sessionPage.count({ where: { orderSessionId: made.id } })
    ).toBe(1);
    await prisma.orderSession.deleteMany({ where: { id: made.id } });
    await prisma.page.delete({ where: { id: face.id } });
  });

  it("refuses a comic that does not exist", async () => {
    await expect(
      createSample(
        input([draftPageIds[0]!], {
          comicId: "00000000-0000-4000-8000-000000000000",
        }),
        admin
      )
    ).rejects.toThrow(/Comic not found/);
  });
});

describe("limits", () => {
  it(`${MAX_LIVE_SAMPLES_PER_ADMIN} live samples per admin; an expired or discarded one does not count`, async () => {
    const made = [];
    for (let i = 0; i < MAX_LIVE_SAMPLES_PER_ADMIN; i++) {
      made.push(await createSample(input([draftPageIds[i]!]), admin));
    }
    await expect(
      createSample(input([draftPageIds[0]!]), admin)
    ).rejects.toThrow(/already have/);
    await discardSample(made[0]!.id);
    const replacement = await createSample(input([draftPageIds[0]!]), admin);
    expect(
      await prisma.orderSession.findUniqueOrThrow({
        where: { id: replacement.id },
      })
    ).toMatchObject({ isSample: true, userId: admin });
  });

  it(`${MAX_LIVE_SAMPLES_OVERALL} live samples overall`, async () => {
    const owners = [admin, admin, otherAdmin, otherAdmin, thirdAdmin];
    for (const owner of owners) {
      await createSample(input([draftPageIds[0]!]), owner);
    }
    await expect(
      createSample(input([draftPageIds[0]!]), thirdAdmin)
    ).rejects.toThrow(/already .* live samples/);
  });

  it("two creations at once with one place left: exactly one is made", async () => {
    await createSample(input([draftPageIds[0]!]), admin);
    await createSample(input([draftPageIds[0]!]), admin);
    const results = await Promise.allSettled([
      createSample(input([draftPageIds[1]!]), admin),
      createSample(input([draftPageIds[2]!]), admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.orderSession.count({
        where: { isSample: true, userId: admin },
      })
    ).toBe(MAX_LIVE_SAMPLES_PER_ADMIN);
  });

  it("23 pages in flight still allow a new sample, 24 do not", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    const add = (count: number, offset: number) =>
      Promise.all(
        Array.from({ length: count }, (_, i) =>
          prisma.pageVersion.create({
            data: {
              orderSessionId: s.id,
              pageId: draftPageIds[0]!,
              variantIndex: offset + i,
              status: "QUEUED",
            },
          })
        )
      );
    await add(23, 0);
    const allowed = await createSample(input([draftPageIds[1]!]), otherAdmin);
    expect(allowed.id).toBeTruthy();
    await add(1, 23);
    await expect(
      createSample(input([draftPageIds[2]!]), thirdAdmin)
    ).rejects.toThrow(/still being generated/);
  });

  it("no new sample while many sample pages are still generating", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    for (let i = 0; i < 12; i++) {
      await prisma.pageVersion.create({
        data: {
          orderSessionId: s.id,
          pageId: draftPageIds[0]!,
          variantIndex: i,
          status: "QUEUED",
        },
      });
    }
    const t = await createSample(input([draftPageIds[1]!]), otherAdmin);
    for (let i = 0; i < 12; i++) {
      await prisma.pageVersion.create({
        data: {
          orderSessionId: t.id,
          pageId: draftPageIds[1]!,
          variantIndex: i,
          status: "GENERATING_SD",
        },
      });
    }
    await expect(
      createSample(input([draftPageIds[2]!]), thirdAdmin)
    ).rejects.toThrow(/still being generated/);
  });
});

describe("a sample cannot reach payment, be edited or be claimed", () => {
  it("every customer route that could lead to payment refuses it", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "PREVIEW_READY", coverType: "HARDCOVER" },
    });

    await expect(initiateCheckout(s.id)).rejects.toThrow(
      SAMPLE_REFUSAL_MESSAGE
    );
    await expect(
      updateOrderSession(s.id, { shippingName: "Someone" })
    ).rejects.toThrow(SAMPLE_REFUSAL_MESSAGE);
    await expect(attachUserToSession(s.id, thirdAdmin)).rejects.toThrow(
      SAMPLE_REFUSAL_MESSAGE
    );
    await expect(sendToPrint(s.id, admin, {} as never)).rejects.toThrow(
      SAMPLE_REFUSAL_MESSAGE
    );

    expect(rzpCreate).not.toHaveBeenCalled();
    expect(await prisma.order.count({ where: { orderSessionId: s.id } })).toBe(
      0
    );
    const after = await prisma.orderSession.findUniqueOrThrow({
      where: { id: s.id },
    });
    expect(after.shippingName).toBeNull();
    expect(after.userId).toBe(admin);
  });

  it("the refusal is a 409", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    await expect(initiateCheckout(s.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("discardSample", () => {
  it("ends the sample now, removes queued versions, keeps finished ones and is repeatable", async () => {
    const s = await createSample(
      input([draftPageIds[0]!, draftPageIds[1]!]),
      admin
    );
    const done = await finishedVersion(s.id, draftPageIds[0]!);
    await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId: draftPageIds[1]!,
        variantIndex: 0,
        status: "QUEUED",
      },
    });
    await discardSample(s.id);
    await discardSample(s.id);
    const row = await prisma.orderSession.findUniqueOrThrow({
      where: { id: s.id },
    });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const versions = await prisma.pageVersion.findMany({
      where: { orderSessionId: s.id },
    });
    expect(versions.map((v) => v.id)).toEqual([done.id]);
    // The ordinary expiry check now refuses new work on it.
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "PHOTO_UPLOADED", bestPhotoUrl: "x" },
    });
    await expect(triggerGeneration(s.id)).rejects.toThrow(/expired/);
  });

  it("does nothing to a customer session", async () => {
    const customer = await prisma.orderSession.create({
      data: { comicId, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(discardSample(customer.id)).rejects.toThrow(
      /Sample not found/
    );
    const row = await prisma.orderSession.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("listSamples", () => {
  it("lists live and waiting samples with a live flag", async () => {
    const live = await createSample(input([draftPageIds[0]!]), admin);
    const gone = await createSample(input([draftPageIds[1]!]), admin);
    await discardSample(gone.id);
    const rows = (await listSamples()).filter((r) =>
      [live.id, gone.id].includes(r.id)
    );
    expect(rows.find((r) => r.id === live.id)).toMatchObject({
      isLive: true,
      pageCount: 1,
    });
    expect(rows.find((r) => r.id === gone.id)).toMatchObject({ isLive: false });
  });
});

describe("buildSamplePdf", () => {
  it("builds a PDF of the chosen versions in page order and stores nothing", async () => {
    const s = await createSample(
      input([draftPageIds[3]!, draftPageIds[1]!]),
      admin
    );
    // Different widths, so the order of the pages in the PDF can be told apart: page 2 (width 50)
    // must come before page 4 (width 40) whatever order the selections arrive in.
    const v1 = await finishedVersion(s.id, draftPageIds[3]!, "SD_READY", 40);
    const v2 = await finishedVersion(s.id, draftPageIds[1]!, "SD_READY", 50);
    const before = await prisma.pageVersion.count({
      where: { orderSessionId: s.id },
    });
    const bytes = await buildSamplePdf(s.id, {
      selections: [
        { pageId: draftPageIds[3]!, pageVersionId: v1.id },
        { pageId: draftPageIds[1]!, pageVersionId: v2.id },
      ],
    });
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 50, height: 60 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 40, height: 60 });
    expect(
      await prisma.pageVersion.count({ where: { orderSessionId: s.id } })
    ).toBe(before);
    expect(await prisma.order.count({ where: { orderSessionId: s.id } })).toBe(
      0
    );
  });

  it("refuses a version of another sample, an unfinished one, a mismatched page, a repeated page and a customer session", async () => {
    const s = await createSample(
      input([draftPageIds[0]!, draftPageIds[1]!]),
      admin
    );
    const t = await createSample(input([draftPageIds[0]!]), otherAdmin);
    const mine = await finishedVersion(s.id, draftPageIds[0]!);
    const theirs = await finishedVersion(t.id, draftPageIds[0]!);
    const unfinished = await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId: draftPageIds[1]!,
        variantIndex: 0,
        status: "GENERATING_SD",
      },
    });
    const call = (selections: { pageId: string; pageVersionId: string }[]) =>
      buildSamplePdf(s.id, { selections });
    await expect(
      call([{ pageId: draftPageIds[0]!, pageVersionId: theirs.id }])
    ).rejects.toThrow(/finished image/);
    await expect(
      call([{ pageId: draftPageIds[1]!, pageVersionId: unfinished.id }])
    ).rejects.toThrow(/finished image/);
    await expect(
      call([{ pageId: draftPageIds[1]!, pageVersionId: mine.id }])
    ).rejects.toThrow(/finished image/);
    await expect(
      call([
        { pageId: draftPageIds[0]!, pageVersionId: mine.id },
        { pageId: draftPageIds[0]!, pageVersionId: mine.id },
      ])
    ).rejects.toThrow(/only once/);
    const customer = await prisma.orderSession.create({
      data: { comicId, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(
      buildSamplePdf(customer.id, {
        selections: [{ pageId: draftPageIds[0]!, pageVersionId: mine.id }],
      })
    ).rejects.toThrow(/Sample not found/);
  });
});

describe("sweepSampleSessions", () => {
  async function expired(msAgo: number, owner = admin) {
    const s = await createSample(input([draftPageIds[0]!]), owner);
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { expiresAt: new Date(Date.now() - msAgo) },
    });
    return s;
  }
  const exists = async (id: string) =>
    (await prisma.orderSession.count({ where: { id } })) === 1;
  const fileExists = (id: string, bucket: "public" | "private") =>
    downloadFileToBuffer(bucket, `sessions/${id}/probe.bin`).then(
      () => true,
      () => false
    );

  it("removes files in both buckets and the rows of a sample that is over", async () => {
    const s = await expired(SAMPLE_CLEANUP_MARGIN_MS + 60_000);
    await finishedVersion(s.id, draftPageIds[0]!);
    await uploadFile(
      "public",
      `sessions/${s.id}/probe.bin`,
      Buffer.from("x"),
      "application/octet-stream"
    );
    await uploadFile(
      "private",
      `sessions/${s.id}/probe.bin`,
      Buffer.from("x"),
      "application/octet-stream"
    );
    expect(await sweepSampleSessions()).toBeGreaterThanOrEqual(1);
    expect(await exists(s.id)).toBe(false);
    expect(await fileExists(s.id, "public")).toBe(false);
    expect(await fileExists(s.id, "private")).toBe(false);
    expect(
      await prisma.pageVersion.count({ where: { orderSessionId: s.id } })
    ).toBe(0);
    expect(
      await prisma.sessionPage.count({ where: { orderSessionId: s.id } })
    ).toBe(0);
  });

  it("leaves a live sample, a sample inside the safety margin, a sample with a page still generating, one with an order, and a customer session", async () => {
    const live = await createSample(input([draftPageIds[0]!]), admin);
    const recent = await expired(SAMPLE_CLEANUP_MARGIN_MS - 60_000, otherAdmin);
    const busy = await expired(SAMPLE_CLEANUP_MARGIN_MS + 60_000, otherAdmin);
    await prisma.pageVersion.create({
      data: {
        orderSessionId: busy.id,
        pageId: draftPageIds[0]!,
        variantIndex: 0,
        status: "TEXT_STAMPED",
      },
    });
    const withOrder = await expired(
      SAMPLE_CLEANUP_MARGIN_MS + 60_000,
      thirdAdmin
    );
    await prisma.order.create({
      data: {
        orderSessionId: withOrder.id,
        amount: 999,
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        shippingName: `${MARK} ${RUN}`,
      },
    });
    const customer = await prisma.orderSession.create({
      data: { comicId, expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    // The row delete would be stopped by the database; the files must not be deleted first.
    // A customer's files must never be touched either.
    for (const id of [withOrder.id, customer.id]) {
      keysToDelete.add(id);
      await uploadFile(
        "public",
        `sessions/${id}/probe.bin`,
        Buffer.from("x"),
        "application/octet-stream"
      );
    }
    await sweepSampleSessions();
    expect(await fileExists(withOrder.id, "public")).toBe(true);
    expect(await fileExists(customer.id, "public")).toBe(true);
    expect(await exists(live.id)).toBe(true);
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(busy.id)).toBe(true);
    expect(await exists(customer.id)).toBe(true);
    expect(await exists(withOrder.id)).toBe(true);
  });

  it("the queued-page cleanup touches only samples without an order, never a customer's pages", async () => {
    const over = new Date(Date.now() - SAMPLE_CLEANUP_MARGIN_MS - 60_000);
    // An expired customer session with waiting and running pages.
    const customer = await prisma.orderSession.create({
      data: { comicId, expiresAt: over },
    });
    const customerRows = await Promise.all(
      (["QUEUED", "GENERATING_SD"] as const).map((status, i) =>
        prisma.pageVersion.create({
          data: {
            orderSessionId: customer.id,
            pageId: draftPageIds[i]!,
            variantIndex: 0,
            status,
          },
        })
      )
    );
    // An expired sample that has an order, with a waiting page.
    const withOrder = await expired(
      SAMPLE_CLEANUP_MARGIN_MS + 60_000,
      thirdAdmin
    );
    await prisma.order.create({
      data: {
        orderSessionId: withOrder.id,
        amount: 999,
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        shippingName: `${MARK} ${RUN}`,
      },
    });
    const orderRow = await prisma.pageVersion.create({
      data: {
        orderSessionId: withOrder.id,
        pageId: draftPageIds[0]!,
        variantIndex: 0,
        status: "QUEUED",
      },
    });
    await sweepSampleSessions();
    expect(
      await prisma.pageVersion.count({
        where: { id: { in: [...customerRows.map((r) => r.id), orderRow.id] } },
      })
    ).toBe(3);
  });

  it("a sample whose queued pages never started is cleaned once it is over", async () => {
    const s = await expired(SAMPLE_CLEANUP_MARGIN_MS + 60_000);
    await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId: draftPageIds[0]!,
        variantIndex: 0,
        status: "QUEUED",
      },
    });
    // First run: the queued rows go, the folder waits one run (a worker may still be writing).
    await sweepSampleSessions();
    expect(await exists(s.id)).toBe(true);
    expect(
      await prisma.pageVersion.count({ where: { orderSessionId: s.id } })
    ).toBe(0);
    await sweepSampleSessions();
    expect(await exists(s.id)).toBe(false);
  });

  it("an interrupted cleanup leaves the rows for the next run", async () => {
    const s = await expired(SAMPLE_CLEANUP_MARGIN_MS + 60_000);
    const r2 = await import("../../src/lib/r2.js");
    const original = r2.r2Client.send.bind(r2.r2Client);
    let failing = true;
    (r2.r2Client as { send: unknown }).send = async (cmd: never) => {
      if (failing) throw new Error("storage down");
      return original(cmd);
    };
    try {
      // The run fails loudly (the scheduled-sweeps endpoint then answers 500) and keeps the rows.
      await expect(sweepSampleSessions()).rejects.toThrow(
        /cleanup failed for 1/
      );
      expect(await exists(s.id)).toBe(true);
    } finally {
      failing = false;
      (r2.r2Client as { send: unknown }).send = original;
    }
    await sweepSampleSessions();
    expect(await exists(s.id)).toBe(false);
  });
});

describe("sample PDF in other states", () => {
  it("is refused once the sample has ended", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    const v = await finishedVersion(s.id, draftPageIds[0]!);
    await discardSample(s.id);
    await expect(
      buildSamplePdf(s.id, {
        selections: [{ pageId: draftPageIds[0]!, pageVersionId: v.id }],
      })
    ).rejects.toThrow(/has ended/);
  });

  it("a build that fails halfway does not block the next one", async () => {
    const s = await createSample(
      input([draftPageIds[0]!, draftPageIds[1]!]),
      admin
    );
    const good = await finishedVersion(s.id, draftPageIds[0]!);
    const missing = await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId: draftPageIds[1]!,
        variantIndex: 0,
        status: "SD_READY",
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/sessions/${s.id}/not-there.png`,
      },
    });
    await expect(
      buildSamplePdf(s.id, {
        selections: [
          { pageId: draftPageIds[0]!, pageVersionId: good.id },
          { pageId: draftPageIds[1]!, pageVersionId: missing.id },
        ],
      })
    ).rejects.toThrow();
    const bytes = await buildSamplePdf(s.id, {
      selections: [{ pageId: draftPageIds[0]!, pageVersionId: good.id }],
    });
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("existing customer routes still work for a real session", () => {
  it("send to print gets past the sample guard and fails on its own check", async () => {
    const s = await prisma.orderSession.create({
      data: {
        comicId,
        userId: admin,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await expect(sendToPrint(s.id, thirdAdmin, {} as never)).rejects.toThrow(
      /do not have permission/
    );
  });

  it("edit and claim behave as before when isSample is false", async () => {
    const s = await prisma.orderSession.create({
      data: { comicId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const edited = await updateOrderSession(s.id, { childName: "Real" });
    expect(edited.childName).toBe("Real");
    const claimed = await attachUserToSession(s.id, thirdAdmin);
    expect(claimed.userId).toBe(thirdAdmin);
  });

  it("the coupon routes cannot price a sample (no cover type or address, and it is not the caller's)", async () => {
    const s = await createSample(input([draftPageIds[0]!]), admin);
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "PREVIEW_READY" },
    });
    await expect(previewCoupon(s.id, admin, "ANYCODE")).rejects.toThrow(
      /cover type and a delivery address/
    );
    await expect(listCouponOffers(s.id, admin)).resolves.toEqual({
      offers: [],
    });
    expect(await prisma.order.count({ where: { orderSessionId: s.id } })).toBe(
      0
    );
  });
});

describe("deletePrefix", () => {
  it("refuses anything but one session folder", async () => {
    for (const bad of [
      "",
      "sessions/",
      "sessions/abc/",
      "pages/",
      "sessions/00000000-0000-4000-8000-000000000000",
      `sessions/${"-".repeat(36)}/`,
      `sessions/${"a".repeat(36)}/`,
      "../x/",
    ]) {
      await expect(deletePrefix("public", bad)).rejects.toThrow(
        /session folder/
      );
    }
  });

  it("pages through more than 1000 objects", async () => {
    const id = "11111111-1111-4111-8111-111111111113";
    keysToDelete.add(id);
    const total = 1005;
    for (let i = 0; i < total; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, total - i) }, (_, j) =>
          uploadFile(
            "public",
            `sessions/${id}/f${i + j}.bin`,
            Buffer.from("x"),
            "application/octet-stream"
          )
        )
      );
    }
    expect(await deletePrefix("public", `sessions/${id}/`)).toBe(total);
    expect(await deletePrefix("public", `sessions/${id}/`)).toBe(0);
  }, 120_000);

  it("deletes only the objects under that folder, across a long listing", async () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "11111111-1111-4111-8111-111111111112";
    keysToDelete.add(a).add(b);
    for (let i = 0; i < 5; i++) {
      await uploadFile(
        "public",
        `sessions/${a}/f${i}.bin`,
        Buffer.from("x"),
        "application/octet-stream"
      );
    }
    await uploadFile(
      "public",
      `sessions/${b}/keep.bin`,
      Buffer.from("x"),
      "application/octet-stream"
    );
    expect(await deletePrefix("public", `sessions/${a}/`)).toBe(5);
    expect(
      (
        await downloadFileToBuffer("public", `sessions/${b}/keep.bin`)
      ).toString()
    ).toBe("x");
    expect(await deletePrefix("public", `sessions/${a}/`)).toBe(0);
  });
});

describe("comic delete and page reorder around samples", () => {
  async function plainComic(label: string, pageCount = 1) {
    const c = await prisma.comic.create({
      data: {
        title: `${MARK} ${RUN} ${label}`,
        pageCount,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    });
    const ids: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const p = await prisma.page.create({
        data: {
          comicId: c.id,
          pageNumber: n,
          isPreviewPage: true,
          artworkUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/__vitest__/art-${label}-${n}.png`,
          artworkWidth: 100,
          artworkHeight: 140,
        },
      });
      ids.push(p.id);
    }
    return { id: c.id, pageIds: ids };
  }

  it("a comic with no sessions is deleted as before", async () => {
    const c = await plainComic("nosessions");
    await deleteComic(c.id);
    expect(await prisma.comic.count({ where: { id: c.id } })).toBe(0);
  });

  it("a comic with a real open session is still refused with the old message", async () => {
    const c = await plainComic("opensession");
    await prisma.orderSession.create({
      data: {
        comicId: c.id,
        status: "PREVIEW_READY",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await expect(deleteComic(c.id)).rejects.toThrow(/active order session/);
  });

  it("a comic can be deleted once its sample has been cleaned up", async () => {
    const c = await plainComic("aftersweep");
    const s = await createSample(
      {
        comicId: c.id,
        childName: "T",
        age: 5,
        pronounKey: "HE",
        pageIds: c.pageIds,
      },
      admin
    );
    await prisma.orderSession.update({
      where: { id: s.id },
      data: {
        expiresAt: new Date(Date.now() - SAMPLE_CLEANUP_MARGIN_MS - 60_000),
      },
    });
    await sweepSampleSessions();
    await deleteComic(c.id);
    expect(await prisma.comic.count({ where: { id: c.id } })).toBe(0);
  });

  it("page reorder is refused while a sample of the comic is live (existing guard, counted as an active session)", async () => {
    const c = await plainComic("reorder", 2);
    await createSample(
      {
        comicId: c.id,
        childName: "T",
        age: 5,
        pronounKey: "HE",
        pageIds: c.pageIds,
      },
      admin
    );
    await expect(
      reorderComicPages(c.id, [c.pageIds[1]!, c.pageIds[0]!])
    ).rejects.toThrow(/active order session/);
  });
});

describe("deleting a comic that has a sample", () => {
  it("is refused with a clear message, live or ended, whatever its status", async () => {
    const comic = await prisma.comic.create({
      data: {
        title: `${MARK} ${RUN} withsample`,
        pageCount: 1,
        freePreviewPages: 1,
        status: "UNPUBLISHED",
      },
    });
    const page = await prisma.page.create({
      data: {
        artworkUrl: "https://example.test/art.png",
        artworkWidth: 100,
        artworkHeight: 140,
        comicId: comic.id,
        pageNumber: 1,
        isPreviewPage: true,
      },
    });
    const s = await createSample(
      {
        comicId: comic.id,
        childName: "T",
        age: 5,
        pronounKey: "HE",
        pageIds: [page.id],
      },
      admin
    );
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "FAILED" },
    });
    // Still live: the admin is told to discard it or wait, not to retry in a few minutes.
    await expect(deleteComic(comic.id)).rejects.toThrow(/still live/);
    // Ended and waiting for the cleanup sweep.
    await discardSample(s.id);
    await expect(deleteComic(comic.id)).rejects.toThrow(/being cleaned up/);
    expect(await prisma.comic.count({ where: { id: comic.id } })).toBe(1);
  });
});
