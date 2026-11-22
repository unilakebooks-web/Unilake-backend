// Integration tests for the blog changes of feature 13: contentUpdatedAt moves only when the reader
// sees different content, publishedAt is set the first time a post is live and never again, the
// featured books (validation, order, replacement, what the public sees), the share fields and the
// old payloads. They run against the Neon TEST branch only: the setup import refuses any other
// database. Storage is stubbed: nothing reaches R2.
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

vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/r2.js")>()),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../src/lib/prisma.js";
import { deleteFile, getPublicUrl } from "../../src/lib/r2.js";
import {
  createBlog,
  deleteBlog,
  getBlogByIdAdmin,
  getBlogBySlugPublic,
  listBlogsAdmin,
  listBlogsPublic,
  toggleBlogStatus,
  updateBlog,
} from "../../src/services/blog.service.js";
import {
  createBlogSchema,
  updateBlogSchema,
} from "../../src/validators/blog.schema.js";
import { ValidationError } from "../../src/utils/errors.js";

const MARK = "__vitest_blogseo__";
const RUN = Math.random().toString(36).slice(2, 8);
const TITLE = (label: string) => `${MARK} ${RUN} ${label}`;

const blogIds: string[] = [];
const comicIds: string[] = [];

async function makeBlog(label: string, extra: Record<string, unknown> = {}) {
  const blog = await createBlog({
    title: TITLE(label),
    excerpt: "An excerpt",
    body: "<p>Body</p>",
    ...extra,
  });
  blogIds.push(blog.id);
  return blog;
}

async function makeComic(
  label: string,
  opts: { status?: "PUBLISHED" | "DRAFT"; retiredAt?: Date } = {}
) {
  const comic = await prisma.comic.create({
    data: {
      title: TITLE(label),
      pageCount: 6,
      freePreviewPages: 2,
      status: opts.status ?? "PUBLISHED",
      coverThumbnailUrls: ["https://example.test/cover.webp"],
      coverThumbnailAlts: ["A cover"],
      ...(opts.retiredAt && { retiredAt: opts.retiredAt }),
    },
  });
  comicIds.push(comic.id);
  return comic;
}

const rowOf = (id: string) => prisma.blog.findUniqueOrThrow({ where: { id } });
const featuredOf = async (id: string) =>
  (await getBlogByIdAdmin(id)).featuredComicIds;

beforeAll(async () => {
  await prisma.blog.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
});

beforeEach(() => {
  vi.mocked(deleteFile).mockClear();
});

afterAll(async () => {
  await prisma.blog.deleteMany({ where: { id: { in: blogIds } } });
  await prisma.comic.deleteMany({ where: { id: { in: comicIds } } });
  await prisma.$disconnect();
});

describe("old payloads", () => {
  it("create and update without any new field still work and the new columns stay empty", async () => {
    const payload = createBlogSchema.parse({
      title: TITLE("old"),
      body: "<p>x</p>",
    });
    const blog = await createBlog(payload);
    blogIds.push(blog.id);
    expect(blog.ogTitle).toBeNull();
    expect(blog.ogImageUrl).toBeNull();
    expect(blog.coverImageAlt).toBeNull();
    expect(blog.contentUpdatedAt).toBeNull();
    expect(blog.publishedAt).toBeNull();
    expect(blog.featuredComicIds).toEqual([]);

    const updated = await updateBlog(
      blog.id,
      updateBlogSchema.parse({ tags: ["a"] })
    );
    expect(updated.tags).toEqual(["a"]);
    expect(await featuredOf(blog.id)).toEqual([]);
  });
});

describe("contentUpdatedAt", () => {
  it("is not set by a resend of the same values (the admin form sends everything)", async () => {
    const blog = await makeBlog("resend", { coverImageKey: "blogs/c1.webp" });
    const same = await updateBlog(blog.id, {
      title: blog.title,
      excerpt: blog.excerpt,
      body: blog.body,
      coverImageKey: "blogs/c1.webp",
      tags: [],
      metaTitle: null,
    });
    expect(same.contentUpdatedAt).toBeNull();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("is not set by a change of tags, meta, share fields or alt", async () => {
    const blog = await makeBlog("nonContent");
    const updated = await updateBlog(blog.id, {
      tags: ["x"],
      metaTitle: "m",
      ogTitle: "o",
      coverImageAlt: "alt",
    });
    expect(updated.contentUpdatedAt).toBeNull();
  });

  it.each([
    ["title", { title: TITLE("renamed") }],
    ["excerpt", { excerpt: "Another excerpt" }],
    ["body", { body: "<p>Changed</p>" }],
    ["cover", { coverImageKey: "blogs/new-cover.webp" }],
  ])("is set when the %s really changes", async (_label, change) => {
    const blog = await makeBlog(`change-${_label}`);
    const before = new Date();
    const updated = await updateBlog(blog.id, change);
    expect(updated.contentUpdatedAt).not.toBeNull();
    expect(updated.contentUpdatedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000
    );
  });

  it("is set when the cover is cleared, and not by the status switch", async () => {
    const blog = await makeBlog("coverClear", {
      coverImageKey: "blogs/c2.webp",
    });
    const cleared = await updateBlog(blog.id, { coverImageKey: null });
    expect(cleared.contentUpdatedAt).not.toBeNull();

    const other = await makeBlog("switch");
    await toggleBlogStatus(other.id);
    expect((await rowOf(other.id)).contentUpdatedAt).toBeNull();
  });

  it("the old value stays when a later save changes nothing", async () => {
    const blog = await makeBlog("keeps");
    const first = await updateBlog(blog.id, { body: "<p>One</p>" });
    const again = await updateBlog(blog.id, {
      body: "<p>One</p>",
      tags: ["t"],
    });
    expect(again.contentUpdatedAt!.getTime()).toBe(
      first.contentUpdatedAt!.getTime()
    );
  });
});

describe("publishedAt", () => {
  it("is empty for a draft and set the first time the post goes live", async () => {
    const blog = await makeBlog("publish");
    expect(blog.publishedAt).toBeNull();
    const live = await toggleBlogStatus(blog.id);
    expect(live.isActive).toBe(true);
    expect(live.publishedAt).not.toBeNull();
  });

  it("never changes after: unpublish and publish again keep the first date", async () => {
    const blog = await makeBlog("republish");
    const first = await toggleBlogStatus(blog.id);
    const off = await toggleBlogStatus(blog.id);
    expect(off.isActive).toBe(false);
    expect(off.publishedAt!.getTime()).toBe(first.publishedAt!.getTime());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const on = await toggleBlogStatus(blog.id);
    expect(on.publishedAt!.getTime()).toBe(first.publishedAt!.getTime());
  });

  it("an edit of a live post does not change it", async () => {
    const blog = await makeBlog("editLive");
    const live = await toggleBlogStatus(blog.id);
    const edited = await updateBlog(blog.id, { body: "<p>Edited</p>" });
    expect(edited.publishedAt!.getTime()).toBe(live.publishedAt!.getTime());
  });

  it("a live post that has no date (written by the previous backend) gets one on its next update, once", async () => {
    const blog = await makeBlog("legacyLive");
    await prisma.blog.update({
      where: { id: blog.id },
      data: { isActive: true, publishedAt: null },
    });
    const first = await updateBlog(blog.id, { tags: ["t"] });
    expect(first.publishedAt).not.toBeNull();
    const second = await updateBlog(blog.id, { tags: ["u"] });
    expect(second.publishedAt!.getTime()).toBe(first.publishedAt!.getTime());
  });

  it("a draft update does not set it", async () => {
    const blog = await makeBlog("draftEdit");
    const updated = await updateBlog(blog.id, { body: "<p>Draft edit</p>" });
    expect(updated.publishedAt).toBeNull();
  });
});

describe("featured books", () => {
  it("saves the books in the order given and returns them as featuredComicIds", async () => {
    const [a, b, c] = [
      await makeComic("fa"),
      await makeComic("fb"),
      await makeComic("fc"),
    ];
    const blog = await makeBlog("featured", {
      featuredComicIds: [c.id, a.id, b.id],
    });
    expect(blog.featuredComicIds).toEqual([c.id, a.id, b.id]);
    expect(await featuredOf(blog.id)).toEqual([c.id, a.id, b.id]);
  });

  it("an update replaces the whole list in the new order; omitting it leaves it alone", async () => {
    const [a, b, c] = [
      await makeComic("ra"),
      await makeComic("rb"),
      await makeComic("rc"),
    ];
    const blog = await makeBlog("replace", { featuredComicIds: [a.id, b.id] });
    await updateBlog(blog.id, { tags: ["untouched"] });
    expect(await featuredOf(blog.id)).toEqual([a.id, b.id]);

    const updated = await updateBlog(blog.id, {
      featuredComicIds: [c.id, b.id],
    });
    expect(updated.featuredComicIds).toEqual([c.id, b.id]);
    expect(await prisma.blogComic.count({ where: { blogId: blog.id } })).toBe(
      2
    );

    await updateBlog(blog.id, { featuredComicIds: [] });
    expect(await featuredOf(blog.id)).toEqual([]);
  });

  it("refuses an unknown comic id and changes nothing", async () => {
    const a = await makeComic("ua");
    const blog = await makeBlog("unknown", { featuredComicIds: [a.id] });
    const ghost = "00000000-0000-4000-8000-00000000dead";
    await expect(
      updateBlog(blog.id, { featuredComicIds: [a.id, ghost] })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await featuredOf(blog.id)).toEqual([a.id]);
    await expect(
      createBlog({
        title: TITLE("ghostCreate"),
        body: "<p>x</p>",
        featuredComicIds: [ghost],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await prisma.blog.count({ where: { title: TITLE("ghostCreate") } })
    ).toBe(0);
  });

  it("the validator refuses duplicates and a seventh id before the service runs", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      updateBlogSchema.safeParse({ featuredComicIds: [id, id] }).success
    ).toBe(false);
    const seven = Array.from(
      { length: 7 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`
    );
    expect(
      updateBlogSchema.safeParse({ featuredComicIds: seven }).success
    ).toBe(false);
  });

  it("the public post shows only published, not retired books, in position order", async () => {
    const pub1 = await makeComic("pub1");
    const draft = await makeComic("draft", { status: "DRAFT" });
    const retired = await makeComic("retired", { retiredAt: new Date() });
    const pub2 = await makeComic("pub2");
    const blog = await makeBlog("public", {
      featuredComicIds: [pub2.id, draft.id, retired.id, pub1.id],
    });
    await toggleBlogStatus(blog.id);

    const post = await getBlogBySlugPublic(blog.slug);
    expect(post.featuredComics.map((c) => c.id)).toEqual([pub2.id, pub1.id]);
    expect(Object.keys(post.featuredComics[0]!).sort()).toEqual(
      ["coverThumbnailAlts", "coverThumbnailUrls", "id", "slug", "title"].sort()
    );
    expect(post.featuredComics[0]!.coverThumbnailAlts).toEqual(["A cover"]);
    // The admin still sees every chosen book, hidden or not.
    expect(await featuredOf(blog.id)).toEqual([
      pub2.id,
      draft.id,
      retired.id,
      pub1.id,
    ]);
  });

  it("a post with no featured books has an empty array publicly", async () => {
    const blog = await makeBlog("none");
    await toggleBlogStatus(blog.id);
    expect((await getBlogBySlugPublic(blog.slug)).featuredComics).toEqual([]);
  });

  it("deleting a comic removes its row and leaves the rest in order", async () => {
    const [a, b, c] = [
      await makeComic("da"),
      await makeComic("db"),
      await makeComic("dc"),
    ];
    const blog = await makeBlog("comicDeleted", {
      featuredComicIds: [a.id, b.id, c.id],
    });
    await prisma.comic.delete({ where: { id: b.id } });
    expect(await featuredOf(blog.id)).toEqual([a.id, c.id]);
  });

  it("deleting the blog removes its rows and leaves the comics", async () => {
    const a = await makeComic("keep");
    const blog = await makeBlog("blogDeleted", { featuredComicIds: [a.id] });
    await deleteBlog(blog.id);
    expect(await prisma.blogComic.count({ where: { blogId: blog.id } })).toBe(
      0
    );
    expect(await prisma.comic.count({ where: { id: a.id } })).toBe(1);
  });
});

describe("share fields and alt", () => {
  it("saves og fields and alt on create and returns the resolved share image URL", async () => {
    const blog = await makeBlog("og", {
      ogTitle: "Share",
      ogDescription: "Share text",
      ogImageKey: "blogs/og1.webp",
      coverImageAlt: "A child reading",
    });
    expect(blog.ogTitle).toBe("Share");
    expect(blog.ogImageUrl).toBe(getPublicUrl("blogs/og1.webp"));
    expect(blog.coverImageAlt).toBe("A child reading");
    expect((await getBlogByIdAdmin(blog.id)).ogDescription).toBe("Share text");
  });

  it("the public post returns them, plus contentUpdatedAt and publishedAt", async () => {
    const blog = await makeBlog("ogPublic", {
      ogTitle: "S",
      ogImageKey: "blogs/og2.webp",
    });
    await toggleBlogStatus(blog.id);
    const post = await getBlogBySlugPublic(blog.slug);
    expect(post.ogTitle).toBe("S");
    expect(post.ogImageUrl).toBe(getPublicUrl("blogs/og2.webp"));
    expect(post).toHaveProperty("coverImageAlt");
    expect(post).toHaveProperty("contentUpdatedAt");
    expect(post.publishedAt).not.toBeNull();
  });

  it("replacing the share image deletes the old file, re-sending the same key does not", async () => {
    const blog = await makeBlog("ogReplace", { ogImageKey: "blogs/og3.webp" });
    await updateBlog(blog.id, { ogImageKey: "blogs/og3.webp" });
    expect(deleteFile).not.toHaveBeenCalled();
    const updated = await updateBlog(blog.id, { ogImageKey: "blogs/og4.webp" });
    expect(updated.ogImageUrl).toBe(getPublicUrl("blogs/og4.webp"));
    expect(deleteFile).toHaveBeenCalledWith("public", "blogs/og3.webp");
    await updateBlog(blog.id, { ogImageKey: null });
    expect((await rowOf(blog.id)).ogImageUrl).toBeNull();
  });

  it("deleting a blog removes its share image file", async () => {
    const blog = await makeBlog("ogDelete", { ogImageKey: "blogs/og5.webp" });
    expect(deleteFile).not.toHaveBeenCalled();
    await deleteBlog(blog.id);
    expect(deleteFile).toHaveBeenCalledWith("public", "blogs/og5.webp");
  });

  it("null clears a share field and the slug stays frozen", async () => {
    const blog = await makeBlog("ogClear", { ogTitle: "Gone soon" });
    const updated = await updateBlog(blog.id, {
      ogTitle: null,
      title: TITLE("ogClearRenamed"),
    });
    expect(updated.ogTitle).toBeNull();
    expect(updated.slug).toBe(blog.slug);
  });
});

describe("lists", () => {
  it("the public list has contentUpdatedAt and publishedAt and still no body", async () => {
    const blog = await makeBlog("listed");
    await toggleBlogStatus(blog.id);
    const item = (await listBlogsPublic()).find((b) => b.id === blog.id);
    expect(item).toBeDefined();
    expect(item).toHaveProperty("contentUpdatedAt");
    expect(item!.publishedAt).not.toBeNull();
    expect(item).not.toHaveProperty("body");
    const adminItem = (await listBlogsAdmin()).find((b) => b.id === blog.id);
    expect(adminItem).not.toHaveProperty("body");
  });
});
