// Integration tests for a blog post's own author (a guest author): saved on create and update,
// cleared by a blank box, left alone when omitted, returned to the admin and on the public post,
// and absent from the lists. Against the Neon TEST branch only (the setup import refuses any other
// database). Storage is stubbed: nothing reaches R2.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/r2.js")>()),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  createBlog,
  getBlogByIdAdmin,
  getBlogBySlugPublic,
  listBlogsPublic,
  toggleBlogStatus,
  updateBlog,
} from "../../src/services/blog.service.js";
import {
  createBlogSchema,
  updateBlogSchema,
} from "../../src/validators/blog.schema.js";

const MARK = "__vitest_blogauthor__";
const RUN = Math.random().toString(36).slice(2, 8);
const TITLE = (label: string) => `${MARK} ${RUN} ${label}`;

const blogIds: string[] = [];

async function makeBlog(label: string, extra: Record<string, unknown> = {}) {
  const blog = await createBlog(
    createBlogSchema.parse({
      title: TITLE(label),
      body: "<p>Body</p>",
      ...extra,
    })
  );
  blogIds.push(blog.id);
  return blog;
}

const GUEST = {
  authorName: "Guest Writer",
  authorInstagramUrl: "https://www.instagram.com/guest",
  authorLinkedinUrl: "https://www.linkedin.com/in/guest",
};

beforeAll(async () => {
  await prisma.blog.deleteMany({ where: { title: { startsWith: MARK } } });
});

afterAll(async () => {
  await prisma.blog.deleteMany({ where: { id: { in: blogIds } } });
  await prisma.$disconnect();
});

describe("post author", () => {
  it("a post created without an author has empty author columns (it uses the site-wide author)", async () => {
    const blog = await makeBlog("none");
    expect(blog.authorName).toBeNull();
    expect(blog.authorInstagramUrl).toBeNull();
    expect(blog.authorLinkedinUrl).toBeNull();
  });

  it("is saved on create and returned to the admin", async () => {
    const blog = await makeBlog("create", GUEST);
    const admin = await getBlogByIdAdmin(blog.id);
    expect(admin).toMatchObject(GUEST);
  });

  it("an update sets it, an update without it leaves it, a blank box clears it", async () => {
    const blog = await makeBlog("update");
    await updateBlog(blog.id, updateBlogSchema.parse(GUEST));
    expect(await getBlogByIdAdmin(blog.id)).toMatchObject(GUEST);

    await updateBlog(blog.id, updateBlogSchema.parse({ tags: ["x"] }));
    expect(await getBlogByIdAdmin(blog.id)).toMatchObject(GUEST);

    await updateBlog(
      blog.id,
      updateBlogSchema.parse({
        authorName: "",
        authorInstagramUrl: "",
        authorLinkedinUrl: "",
      })
    );
    const cleared = await getBlogByIdAdmin(blog.id);
    expect(cleared.authorName).toBeNull();
    expect(cleared.authorInstagramUrl).toBeNull();
    expect(cleared.authorLinkedinUrl).toBeNull();
  });

  it("does not move contentUpdatedAt (same rule as the share fields and alt)", async () => {
    const blog = await makeBlog("content");
    await updateBlog(blog.id, updateBlogSchema.parse(GUEST));
    expect((await getBlogByIdAdmin(blog.id)).contentUpdatedAt).toBeNull();
  });

  it("is on the public post and not in the public list", async () => {
    const blog = await makeBlog("public", GUEST);
    await toggleBlogStatus(blog.id);
    const post = await getBlogBySlugPublic(blog.slug);
    expect(post).toMatchObject(GUEST);

    const listed = (await listBlogsPublic()).find((row) => row.id === blog.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("authorName");
  });
});
