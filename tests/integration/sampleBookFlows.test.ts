// Sample books and the existing customer functions they reuse: regenerate (cap and page list),
// refusals after Discard, and no email. Test branch only; queue and email are stubs.
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

const { addBulk, sendEmail } = vi.hoisted(() => ({
  addBulk: vi.fn(async () => []),
  sendEmail: vi.fn(async () => ({ id: "x" })),
}));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk, getJob: vi.fn(async () => null) },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/email.js", () => ({ sendEmail }));

import { prisma } from "../../src/lib/prisma.js";
import {
  createSample,
  discardSample,
} from "../../src/services/sampleBook.service.js";
import {
  confirmSessionPhoto,
  createPhotoUploadUrl,
  regeneratePage,
  triggerGeneration,
} from "../../src/services/session.service.js";
import { notifyPreviewReady } from "../../src/services/notification.service.js";
import { MAX_VARIANTS_BEFORE_PAYMENT } from "../../src/config/generation.js";

const MARK = "__vitest_sample_flows__";
const RUN = Math.random().toString(36).slice(2, 8);
let adminId = "";
let comicId = "";
let pageIds: string[] = [];

async function cleanup() {
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  adminId = `${MARK}-${RUN}`;
  await prisma.user.create({
    data: { id: adminId, name: "Vitest", email: `${adminId}@example.test` },
  });
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN}`,
      pageCount: 4,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicId = comic.id;
  for (let n = 1; n <= 4; n++) {
    pageIds.push(
      (
        await prisma.page.create({
          data: {
            artworkUrl: "https://example.test/art.png",
            artworkWidth: 100,
            artworkHeight: 140,
            comicId,
            pageNumber: n,
            isPreviewPage: n === 1,
          },
        })
      ).id
    );
  }
});

beforeEach(async () => {
  addBulk.mockClear();
  sendEmail.mockClear();
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const make = async (chosen = [pageIds[0]!, pageIds[1]!]) => {
  const s = await createSample(
    { comicId, childName: "Flow", age: 5, pronounKey: "SHE", pageIds: chosen },
    adminId
  );
  await prisma.orderSession.update({
    where: { id: s.id },
    data: { status: "PREVIEW_READY" },
  });
  return s;
};

describe("generate on a sample", () => {
  it("makes versions and jobs for exactly the chosen pages", async () => {
    const chosen = [pageIds[0]!, pageIds[2]!, pageIds[3]!];
    const s = await createSample(
      { comicId, childName: "Gen", age: 5, pronounKey: "SHE", pageIds: chosen },
      adminId
    );
    await prisma.orderSession.update({
      where: { id: s.id },
      data: {
        status: "PHOTO_UPLOADED",
        bestPhotoUrl: `sessions/${s.id}/photo.jpg`,
      },
    });
    const result = await triggerGeneration(s.id);
    expect(result.jobsEnqueued).toBe(3);
    const versions = await prisma.pageVersion.findMany({
      where: { orderSessionId: s.id },
    });
    expect(versions.map((v) => v.pageId).sort()).toEqual([...chosen].sort());
    expect(versions.every((v) => v.status === "QUEUED")).toBe(true);
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect((addBulk.mock.calls[0] as unknown as [unknown[]])[0]).toHaveLength(
      3
    );
  });
});

describe("regenerate on a sample", () => {
  it("works for a chosen page and queues a job", async () => {
    const s = await make();
    await prisma.pageVersion.create({
      data: {
        orderSessionId: s.id,
        pageId: pageIds[0]!,
        variantIndex: 0,
        status: "SD_READY",
      },
    });
    await regeneratePage(s.id, 1);
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(
      await prisma.pageVersion.count({
        where: { orderSessionId: s.id, pageId: pageIds[0]! },
      })
    ).toBe(2);
  });

  it("refuses a page that is not one of the chosen pages, and creates nothing", async () => {
    const s = await make();
    await expect(regeneratePage(s.id, 3)).rejects.toThrow(
      /not part of this book/
    );
    expect(
      await prisma.pageVersion.count({ where: { orderSessionId: s.id } })
    ).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it(`stops at ${MAX_VARIANTS_BEFORE_PAYMENT} versions of a page`, async () => {
    const s = await make();
    for (let i = 0; i < MAX_VARIANTS_BEFORE_PAYMENT; i++) {
      await prisma.pageVersion.create({
        data: {
          orderSessionId: s.id,
          pageId: pageIds[0]!,
          variantIndex: i,
          status: "SD_READY",
        },
      });
    }
    await expect(regeneratePage(s.id, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(addBulk).not.toHaveBeenCalled();
  });
});

describe("after Discard", () => {
  it("regenerate, generate, photo upload and photo confirm are refused as expired", async () => {
    const s = await make();
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "PHOTO_UPLOADED", bestPhotoUrl: "x" },
    });
    await discardSample(s.id);
    await expect(triggerGeneration(s.id)).rejects.toThrow(/expired/);
    await prisma.orderSession.update({
      where: { id: s.id },
      data: { status: "PREVIEW_READY" },
    });
    await expect(regeneratePage(s.id, 1)).rejects.toThrow(/expired/);
    await expect(createPhotoUploadUrl(s.id, "jpg")).rejects.toThrow(/expired/);
    await expect(
      confirmSessionPhoto(s.id, `sessions/${s.id}/photo-1.jpg`)
    ).rejects.toThrow(/expired/);
    expect(addBulk).not.toHaveBeenCalled();
  });
});

describe("emails", () => {
  it("a sample has no notification email, so the preview-ready email is skipped", async () => {
    const s = await make();
    const result = await notifyPreviewReady(s.id);
    expect(result).toMatchObject({ sent: false, reason: "no_recipient_email" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
