// Integration tests for the page SEO resource (feature 13) and the ABOUT site page: the admin list
// always has all ten pages, a save creates the row, "" and null clear a field, an omitted field is
// left alone, a replaced share image is deleted from storage once and the same key re-sent is not,
// and the public list only has saved pages. They run against the Neon TEST branch only: the setup
// import refuses any other database. Page SEO rows and the ABOUT page are shared singletons, so
// the existing rows are saved before and put back after.
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

// A replaced image is deleted from storage; nothing reaches R2.
vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/r2.js")>()),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../src/lib/prisma.js";
import { deleteFile, getPublicUrl } from "../../src/lib/r2.js";
import {
  listPageSeoAdmin,
  listPageSeoPublic,
  upsertPageSeo,
} from "../../src/services/pageSeo.service.js";
import {
  getSitePagePublic,
  listSitePagesAdmin,
  toggleSitePageStatus,
  upsertSitePage,
} from "../../src/services/sitePage.service.js";
import { NotFoundError } from "../../src/utils/errors.js";

const ALL = [
  "HOME",
  "COMICS",
  "HOW_IT_WORKS",
  "BLOGS",
  "CONTACT",
  "TEAM",
  "ABOUT",
  "PRIVACY",
  "TERMS",
  "REFUND",
];

let savedSeo: Awaited<ReturnType<typeof prisma.pageSeo.findMany>> = [];
let savedAbout: Awaited<ReturnType<typeof prisma.sitePage.findUnique>> = null;

beforeAll(async () => {
  savedSeo = await prisma.pageSeo.findMany();
  savedAbout = await prisma.sitePage.findUnique({ where: { slug: "ABOUT" } });
  await prisma.pageSeo.deleteMany();
  await prisma.sitePage.deleteMany({ where: { slug: "ABOUT" } });
});

beforeEach(() => {
  vi.mocked(deleteFile).mockClear();
});

afterAll(async () => {
  await prisma.pageSeo.deleteMany();
  if (savedSeo.length > 0) await prisma.pageSeo.createMany({ data: savedSeo });
  await prisma.sitePage.deleteMany({ where: { slug: "ABOUT" } });
  if (savedAbout) await prisma.sitePage.create({ data: savedAbout });
  await prisma.$disconnect();
});

describe("admin list", () => {
  it("returns all ten pages as placeholders when nothing is saved", async () => {
    const list = await listPageSeoAdmin();
    expect(list.map((p) => p.slug).sort()).toEqual([...ALL].sort());
    for (const page of list) {
      expect(page.id).toBeNull();
      expect(page.metaTitle).toBeNull();
      expect(page.ogImageUrl).toBeNull();
    }
  });

  it("the public list has no rows until a page is saved", async () => {
    expect((await listPageSeoPublic()).items).toEqual([]);
  });
});

describe("upsert", () => {
  it("creates the row on the first save and shows it in both lists", async () => {
    const saved = await upsertPageSeo("HOME", {
      metaTitle: "Home title",
      ogTitle: "Share title",
      ogImageAlt: "A cover",
    });
    expect(saved.slug).toBe("HOME");

    const home = (await listPageSeoAdmin()).find((p) => p.slug === "HOME");
    expect(home?.id).toBe(saved.id);
    expect(home?.metaTitle).toBe("Home title");
    expect(home?.metaDescription).toBeNull();

    const items = (await listPageSeoPublic()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      slug: "HOME",
      metaTitle: "Home title",
      metaDescription: null,
      ogTitle: "Share title",
      ogDescription: null,
      ogImageUrl: null,
      ogImageAlt: "A cover",
    });
  });

  it("leaves an omitted field alone and clears one sent as null", async () => {
    await upsertPageSeo("HOME", { metaDescription: "Desc" });
    let home = (await listPageSeoAdmin()).find((p) => p.slug === "HOME");
    expect(home?.metaTitle).toBe("Home title");
    expect(home?.metaDescription).toBe("Desc");

    await upsertPageSeo("HOME", { metaTitle: null });
    home = (await listPageSeoAdmin()).find((p) => p.slug === "HOME");
    expect(home?.metaTitle).toBeNull();
    expect(home?.metaDescription).toBe("Desc");
  });

  it("a second save updates the same row", async () => {
    const before = await prisma.pageSeo.count({ where: { slug: "HOME" } });
    await upsertPageSeo("HOME", { ogDescription: "Again" });
    expect(await prisma.pageSeo.count({ where: { slug: "HOME" } })).toBe(
      before
    );
  });
});

describe("share image", () => {
  it("stores the resolved public URL for the key", async () => {
    const saved = await upsertPageSeo("TEAM", {
      ogImageKey: "page-seo/a.webp",
    });
    expect(saved.ogImageUrl).toBe(getPublicUrl("page-seo/a.webp"));
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("re-sending the same key does not delete the live file", async () => {
    await upsertPageSeo("TEAM", {
      ogImageKey: "page-seo/a.webp",
      ogTitle: "x",
    });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("replacing the key deletes the old file once", async () => {
    const saved = await upsertPageSeo("TEAM", {
      ogImageKey: "page-seo/b.webp",
    });
    expect(saved.ogImageUrl).toBe(getPublicUrl("page-seo/b.webp"));
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith("public", "page-seo/a.webp");
  });

  it("clearing the key with null deletes the file and clears the URL", async () => {
    const saved = await upsertPageSeo("TEAM", { ogImageKey: null });
    expect(saved.ogImageUrl).toBeNull();
    expect(deleteFile).toHaveBeenCalledWith("public", "page-seo/b.webp");
  });

  it("a failed delete does not fail the save", async () => {
    await upsertPageSeo("TEAM", { ogImageKey: "page-seo/c.webp" });
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error("storage down"));
    const saved = await upsertPageSeo("TEAM", {
      ogImageKey: "page-seo/d.webp",
    });
    expect(saved.ogImageUrl).toBe(getPublicUrl("page-seo/d.webp"));
  });
});

describe("ABOUT site page", () => {
  it("is listed in the admin as a placeholder with the default title", async () => {
    const about = (await listSitePagesAdmin()).find((p) => p.slug === "ABOUT");
    expect(about).toBeDefined();
    expect(about?.id).toBeNull();
    expect(about?.title).toBe("About Us");
    expect(about?.isActive).toBe(false);
  });

  it("is 404 publicly until it is saved and published, like the other pages", async () => {
    await expect(getSitePagePublic("ABOUT")).rejects.toBeInstanceOf(
      NotFoundError
    );
    await upsertSitePage("ABOUT", { title: "About Us", body: "<p>Hi</p>" });
    await expect(getSitePagePublic("ABOUT")).rejects.toBeInstanceOf(
      NotFoundError
    );
    await toggleSitePageStatus("ABOUT");
    expect((await getSitePagePublic("ABOUT")).title).toBe("About Us");
  });
});
