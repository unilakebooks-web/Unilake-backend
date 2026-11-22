// Integration tests for unpublished comics (feature 6, R6, D-094): the unpublish date, the 30-day rule, delete for a
// comic nobody bought, retire for one with orders, the "retired" guard on every write, and the files the books
// deletion sweep removes (exact keys only, never thumbnails, never a key another comic still uses).
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

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import {
  deleteKeyChecked,
  objectExists,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  deleteComic,
  getAdminComicsList,
  updateComic,
  updateComicPricing,
  updateComicStatus,
} from "../../src/services/comic.service.js";
import {
  createPage,
  deletePage,
  getPageArtworkUploadUrl,
  reorderComicPages,
  updatePage,
} from "../../src/services/page.service.js";
import {
  createBubble,
  deleteBubble,
  updateBubble,
} from "../../src/services/bubble.service.js";
import {
  createFont,
  deleteFont,
  getFontUploadUrl,
  updateFont,
} from "../../src/services/font.service.js";
import {
  createComicFact,
  deleteComicFact,
  toggleComicFactStatus,
  updateComicFact,
} from "../../src/services/comicFact.service.js";
import { createSample } from "../../src/services/sampleBook.service.js";
import { sweepDataDeletion } from "../../src/services/dataDeletion.service.js";
import type { DeletionDeps } from "../../src/services/dataDeletionEngine.service.js";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";

const MARK = "__vitest_deletion_comics__";
const RUN = Math.random().toString(36).slice(2, 8);
const DAY = 24 * 3600_000;
const base = () => config.r2.publicUrlBase.replace(/\/$/, "");
const rzp = {
  fetchPayments: vi.fn(async () => ({
    entity: "collection",
    count: 0,
    items: [],
  })),
  fetchOrder: vi.fn(async () => ({ status: "created" })),
};
const deps = (): DeletionDeps => ({
  now: () => new Date(),
  rzp: rzp as never,
  onlyComicId: "none-we-only-need-comic-items",
});
const keysToDelete = new Set<string>();

async function mkComic(over: Record<string, unknown> = {}) {
  return prisma.comic.create({
    data: {
      title: `${MARK} ${RUN} ${Math.random().toString(36).slice(2, 6)}`,
      pageCount: 2,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
      unpublishedAt: new Date(Date.now() - 31 * DAY),
      ...over,
    },
  });
}

async function mkSession(
  comicId: string,
  over: Record<string, unknown> = {},
  order?: { status: "CREATED" | "DELIVERED" | "CANCELLED" }
) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: "COMPLETED",
      expiresAt: new Date(Date.now() - 100 * DAY),
      rawPhotoUrls: [],
      ...over,
    },
  });
  if (order) {
    await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: order.status,
        razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
        shippingName: `${MARK} ${RUN}`,
      },
    });
  }
  return session;
}

async function setBooks(mode: "OFF" | "ACTIVE") {
  await prisma.deletionGroupSetting.update({
    where: { group: "BOOKS" },
    data: {
      mode,
      approvedSelectionVersion: SELECTION_VERSION.BOOKS,
      approvalExhaustedAt: new Date(),
      approvedAt: new Date(),
      modeChangedAt: new Date(Date.now() - 10 * DAY),
      pausedReason: null,
      pausedAt: null,
    },
  });
  await prisma.deletionSetting.update({
    where: { id: 1 },
    data: { canaryPassedAt: new Date(), leaseUntil: null, leaseOwner: null },
  });
}

async function cleanup() {
  for (const key of keysToDelete) {
    await deleteKeyChecked("public", key).catch(() => {});
    await deleteKeyChecked("private", key).catch(() => {});
  }
  keysToDelete.clear();
  const comics = await prisma.comic.findMany({
    where: { title: { startsWith: MARK } },
    select: { id: true },
  });
  const ids = comics.map((c) => c.id);
  await prisma.deletionItem.deleteMany({ where: { subjectId: { in: ids } } });
  const sessions = await prisma.orderSession.findMany({
    where: { comicId: { in: ids } },
    select: { id: true },
  });
  await prisma.order.deleteMany({
    where: { orderSessionId: { in: sessions.map((s) => s.id) } },
  });
  await prisma.orderSession.deleteMany({ where: { comicId: { in: ids } } });
  await prisma.font.deleteMany({ where: { comicId: { in: ids } } });
  await prisma.page.deleteMany({ where: { comicId: { in: ids } } });
  await prisma.comic.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(cleanup);
beforeEach(async () => {
  await setBooks("OFF");
});
afterAll(async () => {
  await cleanup();
  await prisma.deletionGroupSetting.update({
    where: { group: "BOOKS" },
    data: {
      mode: "REPORT_ONLY",
      approvedRunId: null,
      approvedAt: null,
      approvalExhaustedAt: null,
      pausedReason: null,
      pausedAt: null,
    },
  });
  await prisma.$disconnect();
});

describe("the unpublish date", () => {
  it("is set when a published comic stops being published or a comic moves into UNPUBLISHED, and is never reset by a same-status patch", async () => {
    const published = await mkComic({
      status: "PUBLISHED",
      unpublishedAt: null,
    });
    const unpublished = await updateComicStatus(published.id, {
      status: "UNPUBLISHED",
    });
    expect(unpublished.unpublishedAt).not.toBeNull();
    const first = unpublished.unpublishedAt!.getTime();
    const same = await updateComicStatus(published.id, {
      status: "UNPUBLISHED",
    });
    expect(same.unpublishedAt!.getTime()).toBe(first);
    const draft = await updateComicStatus(published.id, { status: "DRAFT" });
    expect(draft.unpublishedAt!.getTime()).toBe(first);
    const fromDraft = await mkComic({ status: "DRAFT", unpublishedAt: null });
    const moved = await updateComicStatus(fromDraft.id, {
      status: "UNPUBLISHED",
    });
    expect(moved.unpublishedAt).not.toBeNull();
  });
});

describe("the 30-day rule and delete for a comic nobody bought", () => {
  it("refuses before 30 days and when there is no date, allows after, and leaves a never-published draft alone", async () => {
    const early = await mkComic({
      unpublishedAt: new Date(Date.now() - 5 * DAY),
    });
    await expect(deleteComic(early.id)).rejects.toThrow(
      /30 days after it was unpublished/
    );
    const noDate = await mkComic({ unpublishedAt: null });
    await expect(deleteComic(noDate.id)).rejects.toThrow(/no unpublish date/);
    const draft = await mkComic({ status: "DRAFT", unpublishedAt: null });
    await deleteComic(draft.id);
    expect(
      await prisma.comic.findUnique({ where: { id: draft.id } })
    ).toBeNull();
    const ready = await mkComic({
      unpublishedAt: new Date(Date.now() - 31 * DAY),
    });
    await deleteComic(ready.id);
    expect(
      await prisma.comic.findUnique({ where: { id: ready.id } })
    ).toBeNull();
  });
});

describe("retire for a comic that has sessions or orders", () => {
  it("is refused while an order or preview is still live, or while books deletion is not ACTIVE", async () => {
    const comic = await mkComic();
    await mkSession(comic.id, {
      status: "PREVIEW_READY",
      expiresAt: new Date(Date.now() + DAY),
    });
    await expect(deleteComic(comic.id)).rejects.toThrow(/active order session/);
    await prisma.orderSession.updateMany({
      where: { comicId: comic.id },
      data: { status: "COMPLETED" },
    });
    const delivered = await mkSession(
      comic.id,
      { status: "COMPLETED" },
      { status: "DELIVERED" }
    );
    await expect(deleteComic(comic.id)).rejects.toThrow(
      /still live, or their files are not deleted yet/
    );
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${new Date()} WHERE "comicId" = ${comic.id}`;
    await expect(deleteComic(comic.id)).rejects.toThrow(
      /books must be switched on/i
    );
    void delivered;
  });

  it("an abandoned checkout whose files were deleted no longer counts as active", async () => {
    const comic = await mkComic();
    const abandoned = await mkSession(
      comic.id,
      {
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() - 10 * DAY),
      },
      { status: "CREATED" }
    );
    await expect(deleteComic(comic.id)).rejects.toThrow(/active order session/);
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${new Date()}, "photoDeletedAt" = ${new Date()} WHERE "id" = ${abandoned.id}`;
    await setBooks("ACTIVE");
    await deleteComic(comic.id);
    const after = await prisma.comic.findUniqueOrThrow({
      where: { id: comic.id },
    });
    expect(after.retiredAt).not.toBeNull();
  });

  it("retires, refuses every later write by id, shows 'retired' in the admin list, and a publish cannot win", async () => {
    const comic = await mkComic();
    const delivered = await mkSession(
      comic.id,
      { status: "COMPLETED" },
      { status: "DELIVERED" }
    );
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${new Date()} WHERE "id" = ${delivered.id}`;
    await setBooks("ACTIVE");
    await deleteComic(comic.id);
    const retired = await prisma.comic.findUniqueOrThrow({
      where: { id: comic.id },
    });
    expect(retired.retiredAt).not.toBeNull();
    expect(
      await prisma.deletionItem.findUnique({
        where: { subjectId_scope: { subjectId: comic.id, scope: "COMIC" } },
      })
    ).toMatchObject({ state: "CLAIMED" });
    await expect(
      updateComicStatus(comic.id, { status: "PUBLISHED" })
    ).rejects.toThrow(/retired/);
    await expect(
      updateComic(comic.id, { title: "new" } as never)
    ).rejects.toThrow(/retired/);
    await expect(
      createPage(comic.id, { pageNumber: 5 } as never)
    ).rejects.toThrow(/retired/);
    await expect(
      createFont(comic.id, { name: "f", fileKey: "x" } as never)
    ).rejects.toThrow(/retired/);
    await expect(
      createSample(
        {
          comicId: comic.id,
          childName: "x",
          age: 5,
          pronounKey: "SHE",
          pageIds: [],
        } as never,
        "admin"
      )
    ).rejects.toThrow(/retired/);
    const list = (await getAdminComicsList({} as never)).find(
      (c) => c.id === comic.id
    );
    expect(list?.deleteEligibility).toMatchObject({
      canDelete: false,
      kind: "retired",
    });
  });
});

describe("the books sweep deletes a retired comic's own files", () => {
  it("deletes page art, masks, the video, fonts and the LoRA file; keeps thumbnails and any key another comic uses", async () => {
    const comic = await mkComic();
    const other = await mkComic();
    const delivered = await mkSession(
      comic.id,
      { status: "COMPLETED" },
      { status: "DELIVERED" }
    );
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${new Date()} WHERE "id" = ${delivered.id}`;
    const id = comic.id;
    const art = `comics/${id}/pages/artwork/${RUN}-a.png`;
    const mask = `comics/${id}/pages/masks/${RUN}-m.png`;
    const font = `comics/${id}/fonts/${RUN}-f.ttf`;
    const video = `comics/videos/${RUN}-shared.mp4`;
    const soloVideo = `comics/videos/${RUN}-solo.mp4`;
    const lora = `comics/lora/${Date.now()}-${RUN}.safetensors`;
    const thumb = `comics/thumbnails/${RUN}-t.png`;
    for (const k of [art, mask, video, soloVideo, thumb]) {
      await uploadFile(
        "public",
        k,
        Buffer.from("x"),
        "application/octet-stream"
      );
      keysToDelete.add(k);
    }
    for (const k of [font, lora]) {
      await uploadFile(
        "private",
        k,
        Buffer.from("x"),
        "application/octet-stream"
      );
      keysToDelete.add(k);
    }
    await prisma.page.create({
      data: {
        comicId: id,
        pageNumber: 1,
        artworkUrl: `${base()}/${art}`,
        maskUrl: `${base()}/${mask}`,
      },
    });
    await prisma.font.create({
      data: { comicId: id, name: "f", fileUrl: font },
    });
    await prisma.comic.update({
      where: { id },
      data: {
        previewVideoUrl: `${base()}/${video}`,
        loraFileUrl: lora,
        coverThumbnailUrls: [`${base()}/${thumb}`],
      },
    });
    // another comic still uses the shared video
    await prisma.comic.update({
      where: { id: other.id },
      data: { previewVideoUrl: `${base()}/${video}` },
    });
    await setBooks("ACTIVE");
    await deleteComic(id);
    await sweepDataDeletion(deps());
    expect(await objectExists("public", art)).toBe(false);
    expect(await objectExists("public", mask)).toBe(false);
    expect(await objectExists("private", font)).toBe(false);
    expect(await objectExists("private", lora)).toBe(false);
    expect(await objectExists("public", thumb)).toBe(true); // thumbnails are never deleted
    expect(await objectExists("public", video)).toBe(true); // another comic still uses it
    const done = await prisma.comic.findUniqueOrThrow({ where: { id } });
    expect(done.filesDeletedAt).not.toBeNull();
    expect(
      (
        await prisma.deletionItem.findUniqueOrThrow({
          where: { subjectId_scope: { subjectId: id, scope: "COMIC" } },
        })
      ).state
    ).toBe("DONE");
    // once its files are gone it leaves the admin list
    expect(
      (await getAdminComicsList({} as never)).some((c) => c.id === id)
    ).toBe(false);
  });
});

describe("the books sweep keeps a file that a share picture names", () => {
  it("keeps page art named by another comic's, a post's or a page's share picture, and still deletes an unnamed one", async () => {
    const comic = await mkComic();
    const other = await mkComic();
    const delivered = await mkSession(
      comic.id,
      { status: "COMPLETED" },
      { status: "DELIVERED" }
    );
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = ${new Date()} WHERE "id" = ${delivered.id}`;
    const id = comic.id;
    const art = [1, 2, 3, 4].map(
      (n) => `comics/${id}/pages/artwork/${RUN}-og${n}.png`
    );
    for (const k of art) {
      await uploadFile(
        "public",
        k,
        Buffer.from("x"),
        "application/octet-stream"
      );
      keysToDelete.add(k);
    }
    for (const [i, k] of art.entries())
      await prisma.page.create({
        data: {
          comicId: id,
          pageNumber: i + 1,
          artworkUrl: `${base()}/${k}`,
        },
      });
    const blog = await prisma.blog.create({
      data: {
        slug: `og-keep-${RUN}`,
        title: "Share picture test",
        body: "<p>x</p>",
        ogImageUrl: `${base()}/${art[1]}`,
      },
    });
    const hadPageSeo = await prisma.pageSeo.findUnique({
      where: { slug: "HOME" },
    });
    try {
      await prisma.pageSeo.upsert({
        where: { slug: "HOME" },
        create: { slug: "HOME", ogImageUrl: `${base()}/${art[2]}` },
        update: { ogImageUrl: `${base()}/${art[2]}` },
      });
      await prisma.comic.update({
        where: { id: other.id },
        data: { ogImageUrl: `${base()}/${art[0]}` },
      });
      await setBooks("ACTIVE");
      await deleteComic(id);
      await sweepDataDeletion(deps());
      expect(await objectExists("public", art[0]!)).toBe(true); // named by another comic's share picture
      expect(await objectExists("public", art[1]!)).toBe(true); // named by a post's share picture
      expect(await objectExists("public", art[2]!)).toBe(true); // named by a page's share picture
      expect(await objectExists("public", art[3]!)).toBe(false); // named by nothing
    } finally {
      await prisma.blog.delete({ where: { id: blog.id } });
      if (hadPageSeo) {
        await prisma.pageSeo.update({
          where: { slug: "HOME" },
          data: { ogImageUrl: hadPageSeo.ogImageUrl },
        });
      } else {
        await prisma.pageSeo.deleteMany({ where: { slug: "HOME" } });
      }
    }
  });
});

describe("every admin write on a retired comic is refused", () => {
  it("pricing, pages, bubbles, fonts and facts, by comic, page, bubble, font or fact id", async () => {
    const comic = await mkComic();
    const page = await prisma.page.create({
      data: { comicId: comic.id, pageNumber: 1 },
    });
    const font = await prisma.font.create({
      data: {
        comicId: comic.id,
        name: "f",
        fileUrl: `comics/${comic.id}/fonts/x.ttf`,
      },
    });
    const bubble = await prisma.bubble.create({
      data: {
        pageId: page.id,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
        dialogue: "hi",
      },
    });
    const fact = await prisma.comicFact.create({
      data: {
        comicId: comic.id,
        placement: "PRELOADER",
        text: "fact",
      },
    });
    await prisma.$executeRaw`UPDATE "comics" SET "retiredAt" = ${new Date()} WHERE "id" = ${comic.id}`;
    const calls: [string, () => Promise<unknown>][] = [
      ["updateComicPricing", () => updateComicPricing(comic.id, {} as never)],
      [
        "getPageArtworkUploadUrl",
        () => getPageArtworkUploadUrl(comic.id, {} as never),
      ],
      ["createPage", () => createPage(comic.id, {} as never)],
      ["updatePage", () => updatePage(page.id, {} as never)],
      ["deletePage", () => deletePage(page.id)],
      ["reorderComicPages", () => reorderComicPages(comic.id, {} as never)],
      ["createBubble", () => createBubble(page.id, {} as never)],
      ["updateBubble", () => updateBubble(bubble.id, {} as never)],
      ["deleteBubble", () => deleteBubble(bubble.id)],
      ["getFontUploadUrl", () => getFontUploadUrl(comic.id, {} as never)],
      ["createFont", () => createFont(comic.id, {} as never)],
      ["updateFont", () => updateFont(font.id, {} as never)],
      ["deleteFont", () => deleteFont(font.id)],
      ["createComicFact", () => createComicFact(comic.id, {} as never)],
      ["updateComicFact", () => updateComicFact(fact.id, {} as never)],
      ["toggleComicFactStatus", () => toggleComicFactStatus(fact.id)],
      ["deleteComicFact", () => deleteComicFact(fact.id)],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow(/retired/);
    }
    await prisma.bubble.deleteMany({ where: { id: bubble.id } });
    await prisma.comicFact.deleteMany({ where: { id: fact.id } });
  });
});
