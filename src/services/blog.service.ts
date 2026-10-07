import { randomUUID } from "node:crypto";
import {
  deleteFile,
  getKeyFromPublicUrl,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";

const UPLOAD_EXPIRY_SECONDS = 15 * 60;
const MAX_SLUG_ATTEMPTS = 50;

// Everything a list needs. `body` is deliberately excluded — it is the full
// HTML article and has no business travelling in a listing payload.
const BLOG_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  coverImageUrl: true,
  tags: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics becomes one hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 100);
}

/**
 * Slugifies the title and appends -2, -3, ... until the slug is free.
 *
 * The `|| "post"` fallback is load-bearing: a title of "123" or "!!!" strips
 * down to an empty string, which would otherwise make every such post collide
 * on "" and start suffixing off nothing.
 *
 * Bounded rather than a while(true) — a pathological title that somehow
 * collides 50 times should fail loudly, not spin.
 */
async function generateUniqueSlug(title: string): Promise<string> {
  const base = slugify(title) || "post";
  let slug = base;
  let suffix = 2;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const existing = await prisma.blog.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (!existing) return slug;

    slug = `${base}-${suffix}`;
    suffix++;
  }

  throw new ConflictError(
    "Could not generate a unique slug for this title. Try a slightly different title."
  );
}

/**
 * Presigned upload URL for both blog cover images and images embedded in the
 * body by the rich-text editor.
 *
 * Returns `publicUrl` as well as the key because of the second case: a cover
 * travels back as a key and is resolved server-side at save time, but an
 * in-body image has to be written straight into the stored HTML as an absolute
 * src, so the caller needs the resolved URL up front. Handing it over here
 * keeps getPublicUrl() the single owner of that mapping — the alternative was
 * exposing the R2 base to the frontend bundle.
 */
export async function getBlogUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
  const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `blogs/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated blog image upload URL");

  return { uploadUrl, key, publicUrl: getPublicUrl(key) };
}

export async function createBlog(data: {
  title: string;
  excerpt?: string;
  body: string;
  coverImageKey?: string;
  tags?: string[];
  metaTitle?: string;
  metaDescription?: string;
}) {
  const slug = await generateUniqueSlug(data.title);

  try {
    // isActive is left unset so the DB default (false) applies — a new post is
    // never live while it is still being written.
    const blog = await prisma.blog.create({
      data: {
        slug,
        title: data.title,
        body: data.body,
        tags: data.tags ?? [],
        ...(data.excerpt !== undefined && { excerpt: data.excerpt }),
        // Left unset when absent, so the column stays null and the post falls
        // back to its own title/excerpt for search results.
        ...(data.metaTitle !== undefined && { metaTitle: data.metaTitle }),
        ...(data.metaDescription !== undefined && {
          metaDescription: data.metaDescription,
        }),
        ...(data.coverImageKey !== undefined && {
          coverImageUrl: getPublicUrl(data.coverImageKey),
        }),
      },
    });

    logger.info({ blogId: blog.id, slug: blog.slug }, "Blog created");

    return blog;
  } catch (error: any) {
    // Two concurrent creates with the same title can both clear the uniqueness
    // check above before either writes. The unique constraint catches the loser.
    if (error.code === "P2002") {
      throw new ConflictError(
        "A blog with this slug already exists. Please try again."
      );
    }

    throw error;
  }
}

export async function updateBlog(
  id: string,
  data: {
    title?: string;
    excerpt?: string | null;
    body?: string;
    coverImageKey?: string | null;
    tags?: string[];
    metaTitle?: string | null;
    metaDescription?: string | null;
  }
) {
  const existing = await prisma.blog.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Blog not found");
  }

  const updateData: Prisma.BlogUpdateInput = {};
  const oldR2Keys: string[] = [];

  // `!== undefined` rather than a truthiness check, so an explicit null on
  // excerpt actually clears the column.
  if (data.title !== undefined) updateData.title = data.title;
  if (data.excerpt !== undefined) updateData.excerpt = data.excerpt;
  if (data.body !== undefined) updateData.body = data.body;
  if (data.tags !== undefined) updateData.tags = data.tags;
  // Same null-clears-it rule as excerpt above.
  if (data.metaTitle !== undefined) updateData.metaTitle = data.metaTitle;
  if (data.metaDescription !== undefined)
    updateData.metaDescription = data.metaDescription;

  // The slug is never touched here — it is frozen at create so that a title
  // edit can never 404 a link someone already shared.

  // Cover image: omitted = unchanged, a key = replace, null = clear.
  // Guard on oldUrl !== newUrl so re-submitting the same key (an edit form
  // that resends every field) never deletes the live file.
  if (data.coverImageKey !== undefined) {
    const newCoverUrl =
      data.coverImageKey === null ? null : getPublicUrl(data.coverImageKey);

    updateData.coverImageUrl = newCoverUrl;

    if (existing.coverImageUrl && existing.coverImageUrl !== newCoverUrl) {
      oldR2Keys.push(getKeyFromPublicUrl(existing.coverImageUrl));
    }
  }

  const updated = await prisma.blog.update({
    where: { id },
    data: updateData,
  });

  // Best-effort, after the DB write succeeds. A failed delete leaves an orphan
  // file in R2, not a broken row.
  for (const key of oldR2Keys) {
    try {
      await deleteFile("public", key);
      logger.info({ blogId: id, key }, "Old blog cover image deleted from R2");
    } catch (error) {
      logger.warn(
        { error, blogId: id, key },
        "Blog cover replaced/cleared but old R2 file cleanup failed"
      );
    }
  }

  logger.info(
    { blogId: id, updatedFields: Object.keys(updateData) },
    "Blog updated"
  );

  return updated;
}

export async function listBlogsAdmin(isActive?: boolean) {
  const blogs = await prisma.blog.findMany({
    where: isActive !== undefined ? { isActive } : undefined,
    orderBy: { createdAt: "desc" },
    select: BLOG_LIST_SELECT,
  });

  return blogs;
}

export async function getBlogByIdAdmin(id: string) {
  const blog = await prisma.blog.findUnique({ where: { id } });

  if (!blog) {
    throw new NotFoundError("Blog not found");
  }

  return blog;
}

export async function listBlogsPublic() {
  const blogs = await prisma.blog.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
    select: BLOG_LIST_SELECT,
  });

  return blogs;
}

export async function getBlogBySlugPublic(slug: string) {
  const blog = await prisma.blog.findFirst({
    where: { slug, isActive: true },
  });

  // "No such slug" and "exists but unpublished" deliberately return the same
  // 404 — same reasoning as the public comic detail endpoint. Do not leak
  // the existence of unpublished drafts.
  if (!blog) {
    throw new NotFoundError("Blog not found");
  }

  return blog;
}

export async function toggleBlogStatus(id: string) {
  const existing = await prisma.blog.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Blog not found");
  }

  const updated = await prisma.blog.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { blogId: id, isActive: updated.isActive },
    "Blog status toggled"
  );

  return updated;
}

export async function deleteBlog(id: string) {
  const existing = await prisma.blog.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Blog not found");
  }

  const coverR2Key = existing.coverImageUrl
    ? getKeyFromPublicUrl(existing.coverImageUrl)
    : null;

  // DB row first, then best-effort R2 cleanup — same ordering as
  // CustomerReview and TeamMember.
  await prisma.blog.delete({ where: { id } });

  if (coverR2Key) {
    try {
      await deleteFile("public", coverR2Key);
      logger.info({ blogId: id, coverR2Key }, "Blog and cover image deleted");
    } catch (error) {
      logger.warn(
        { error, blogId: id, coverR2Key },
        "Blog deleted but cover image R2 cleanup failed"
      );
    }
  } else {
    logger.info({ blogId: id }, "Blog deleted (no cover image to clean up)");
  }

  // NOTE: images embedded inside `body` are NOT cleaned up. Diffing <img> tags
  // out of an HTML string is not worth the fragility; they are accepted as
  // dead storage.
}
