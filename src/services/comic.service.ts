import { randomUUID } from "node:crypto";
import {
  deleteFile,
  getKeyFromPublicUrl,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import type {
  AdminComicFilterQueryInput,
  ComicFilterQueryInput,
  CreateComicInput,
  GetComicVideoUploadUrlInput,
  GetLoraUploadUrlInput,
  UpdateComicPricingInput,
  UpdateComicStatusInput,
  UploadThumbnailsBatchInput,
} from "../validators/comic.schema.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { UpdateComicInput } from "../validators/comic.schema.js";

/**
 * Accepts either a raw R2 key or a full public URL and always returns a key.
 *
 * Thumbnails are the only asset stored as an ARRAY, which means updating them
 * requires the client to re-send the entries it wants to KEEP. Those come back
 * from GET as full URLs, so tolerating both forms here lets the frontend send
 * exactly what it received (minus whatever it is deleting) instead of having to
 * know R2_PUBLIC_URL_BASE and reverse the conversion itself — a mismatch there
 * would silently produce doubled URLs.
 *
 * Kept local deliberately. r2.getKeyFromPublicUrl() is reserved for the SD
 * worker: it assumes its input is always a URL, whereas this one handles
 * untrusted client input that may legitimately be either form.
 */
const normalizeThumbnailInput = (input: string): string => {
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const prefix = `${publicBase}/`;

  return input.startsWith(prefix) ? input.slice(prefix.length) : input;
};

/**
 * Throws a 400 when any of the given theme ids does not exist.
 *
 * Without this, `connect` / `set` on a missing theme fails inside Prisma with
 * a P2025 that surfaces as an opaque 500. A theme can legitimately vanish
 * between the admin loading the form and saving it (deleted in another tab),
 * so this is a user-facing error, not a programming one.
 *
 * `ids` is already de-duplicated by the Zod schema, so the count comparison is
 * exact.
 */
const assertThemesExist = async (ids: string[]): Promise<void> => {
  const found = await prisma.theme.count({ where: { id: { in: ids } } });
  if (found !== ids.length) {
    throw new ValidationError(
      "One or more selected themes no longer exist. Refresh the page and pick again."
    );
  }
};

/** Shape every comic response uses for its themes — alphabetical, id + name. */
const THEMES_SELECT = {
  select: { id: true, name: true },
  orderBy: { name: "asc" },
} as const;

export const generateThumbnailUploadUrl = async (
  fileName: string,
  contentType: string
) => {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");

  const key = `comics/temp/${randomUUID()}-${safeFileName}`;

  logger.info(
    { key, contentType },
    "Requesting presigned URL for comic thumbnail"
  );

  const uploadUrl = await getSignedUploadUrl("public", key, contentType, 900);

  return { uploadUrl, key };
};

// Longer than the 15-minute thumbnail window: the admin UI caps videos at 100 MB
// and that can take a while to PUT on a slow connection. The URL only authorizes
// a single write to one UUID key, so a longer window costs nothing.
const COMIC_VIDEO_UPLOAD_EXPIRY_SECONDS = 30 * 60;

/**
 * Presigned PUT for a comic's optional promo video.
 *
 * Comic-agnostic by design, exactly like the thumbnail and LoRA equivalents:
 * the key is UUID-based, so no comicId is needed to issue it and nothing is
 * written to the DB here. The comic only learns about the file when the admin
 * PATCHes the returned key back as `videoKey`.
 */
export const generateComicVideoUploadUrl = async (
  fileName: GetComicVideoUploadUrlInput["fileName"],
  contentType: GetComicVideoUploadUrlInput["contentType"]
) => {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");

  const key = `comics/videos/${randomUUID()}-${safeFileName}`;

  logger.info(
    { key, contentType },
    "Requesting presigned URL for comic preview video"
  );

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    contentType,
    COMIC_VIDEO_UPLOAD_EXPIRY_SECONDS
  );

  return { uploadUrl, key };
};

export const createComic = async (data: CreateComicInput) => {
  try {
    logger.info(
      { title: data.title },
      "Attempting to create new comic catalogue item..."
    );

    // themeIds is not a column — it becomes the comic <-> theme links below.
    const { thumbnailKeys, pricing, loraKey, themeIds, ...restData } = data;
    await assertThemesExist(themeIds);
    // Create only ever receives fresh keys today, but normalizing here keeps
    // create and update behaving identically for any future caller.
    const coverThumbnailUrls = thumbnailKeys.map((entry) =>
      getPublicUrl(normalizeThumbnailInput(entry))
    );

    const newComic = await prisma.$transaction(async (tx) => {
      const comic = await tx.comic.create({
        data: {
          ...restData,
          coverThumbnailUrls,
          status: "DRAFT",
          themes: { connect: themeIds.map((id) => ({ id })) },
          ...(loraKey !== undefined && { loraFileUrl: loraKey }),
        },
      });

      // Step B: Bulk-insert the pricing rules linked to the new comic's ID
      await tx.pricingRule.createMany({
        data: pricing.map((p) => ({
          comicId: comic.id,
          countryId: p.countryId,
          coverType: p.coverType,
          mrp: p.mrp,
          price: p.price,
        })),
      });
      return comic;
    });

    logger.info(
      { comicId: newComic.id },
      "Successfully created draft comic with pricing rules"
    );
    return newComic;
  } catch (error: any) {
    logger.error({ err: error, data }, "Failed to create comic in database");

    if (error.code === "P2002") {
      throw new ConflictError(
        "A pricing rule conflict occurred, or a comic with this parameter exists."
      );
    }

    throw error;
  }
};

export const updateComic = async (comicId: string, data: UpdateComicInput) => {
  try {
    const comic = await prisma.comic.findUnique({ where: { id: comicId } });

    if (!comic) {
      throw new NotFoundError("Comic not found.");
    }

    const updateData: Prisma.ComicUpdateInput = {};
    let oldR2KeysToDelete: string[] = [];

    if (data.title !== undefined) updateData.title = data.title;
    if (data.genderTags !== undefined) updateData.genderTags = data.genderTags;
    if (data.pageCount !== undefined) updateData.pageCount = data.pageCount;
    if (data.freePreviewPages !== undefined) updateData.freePreviewPages = data.freePreviewPages;
    if (data.loraStrength !== undefined) updateData.loraStrength = data.loraStrength;
    if (data.loraKey !== undefined) updateData.loraFileUrl = data.loraKey;
    if (data.thumbnailKeys !== undefined) {
      // Entries may arrive as freshly-uploaded keys OR as URLs the client is
      // re-sending to keep. Normalizing both to keys first means the diff below
      // compares like with like, so a kept thumbnail is never seen as removed.
      const newUrls = data.thumbnailKeys.map((entry) =>
        getPublicUrl(normalizeThumbnailInput(entry))
      );
      updateData.coverThumbnailUrls = newUrls;

      const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
      const removedUrls = comic.coverThumbnailUrls.filter((u) => !newUrls.includes(u));
      oldR2KeysToDelete = removedUrls.map((u) => u.replace(`${publicBase}/`, ""));
    }
    if (data.videoKey !== undefined) {
      // Scalar, so the contract is simpler than thumbnailKeys': omitted means
      // unchanged, a key means replace, null means remove. It is never asked to
      // accept a URL the client is re-sending to keep, which is why this skips
      // normalizeThumbnailInput — that helper exists only for the array's
      // send-back-what-you-keep semantics.
      const newVideoUrl =
        data.videoKey === null ? null : getPublicUrl(data.videoKey);
      updateData.previewVideoUrl = newVideoUrl;

      // The old≠new guard is load-bearing, not defensive: without it, saving the
      // same key twice would delete the very file the row still points at.
      // getKeyFromPublicUrl is safe here because its input is always a URL this
      // service wrote, never untrusted client input.
      if (comic.previewVideoUrl && comic.previewVideoUrl !== newVideoUrl) {
        oldR2KeysToDelete.push(getKeyFromPublicUrl(comic.previewVideoUrl));
      }
    }
    if (data.description !== undefined) updateData.description = data.description;
    // `!== undefined` rather than truthiness, so an explicit null clears the
    // override and the page falls back to title/description again.
    if (data.metaTitle !== undefined) updateData.metaTitle = data.metaTitle;
    if (data.metaDescription !== undefined)
      updateData.metaDescription = data.metaDescription;
    // `set`, not `connect`: the sent list REPLACES the comic's themes, so a
    // theme the admin un-ticked is unlinked rather than kept.
    if (data.themeIds !== undefined) {
      await assertThemesExist(data.themeIds);
      updateData.themes = { set: data.themeIds.map((id) => ({ id })) };
    }
    if (data.ageGroups !== undefined) updateData.ageGroups = data.ageGroups;
    if (data.isBestseller !== undefined) updateData.isBestseller = data.isBestseller;
    // if (data.generationPrompt !== undefined)
    //   updateData.generationPrompt = data.generationPrompt;
    // if (data.generationNegativePrompt !== undefined)
    //   updateData.generationNegativePrompt = data.generationNegativePrompt;

    const updatedComic = await prisma.comic.update({
      where: { id: comicId },
      data: updateData,
    });

    for (const oldR2Key of oldR2KeysToDelete) {
      try {
        await deleteFile("public", oldR2Key);
        logger.info({ comicId, oldR2Key }, "Old comic thumbnail deleted from R2");
      } catch (error) {
        logger.warn({ error, comicId, oldR2Key }, "Failed to delete old comic thumbnail from R2");
      }
    }
    logger.info(
      { comicId, updatedFields: Object.keys(updateData) },
      "Successfully updated comic"
    );

    return updatedComic;
  } catch (error: any) {
    logger.error({ err: error, comicId }, "Failed to update comic");
    throw error;
  }
};

export async function deleteComic(comicId: string) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    include: {
      pages: {
        select: { artworkUrl: true, maskUrl: true },
      },
      _count: {
        select: { orderSessions: true },
      },
    },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found.");
  }

  if (comic.status === "PUBLISHED") {
    throw new ConflictError(
      "Cannot delete a published comic. Unpublish it first."
    );
  }

  // Check for active (non-terminal) order sessions
  const activeSessionCount = await prisma.orderSession.count({
    where: {
      comicId,
      status: {
        notIn: ["COMPLETED", "FAILED"],
      },
    },
  });

  if (activeSessionCount > 0) {
    throw new ConflictError(
      `Cannot delete this comic — it has ${activeSessionCount} active order session(s). Wait for them to complete or fail first.`
    );
  }

  // Collect ALL R2 keys we'll clean up BEFORE the DB delete — thumbnails plus
  // every page's artwork and mask. Nothing hits R2 yet; this is just planning.
  const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const thumbnailKeys = comic.coverThumbnailUrls.map((url) =>
    url.replace(`${publicBase}/`, "")
  );
  const pageAssetKeys = comic.pages.flatMap((p) =>
    [p.artworkUrl, p.maskUrl]
      .filter((url): url is string => Boolean(url))
      .map((url) => url.replace(`${publicBase}/`, ""))
  );
  // The promo video is nullable and most comics have none, so this is usually
  // empty. It still has to be swept: a video can be ~100 MB, and nothing else
  // in the system would ever reference it again once the comic row is gone.
  const videoKeys = comic.previewVideoUrl
    ? [comic.previewVideoUrl.replace(`${publicBase}/`, "")]
    : [];

  // DB delete is the moment of truth. If it throws, we haven't touched R2 —
  // caller sees an error and the comic + all its assets stay intact, exactly
  // recoverable by retrying the delete. Pages cascade-delete in the DB via
  // the schema's onDelete: Cascade. (Audit 8.15 — DB first, R2 second.)
  await prisma.comic.delete({ where: { id: comicId } });

  // Best-effort R2 cleanup AFTER the DB delete succeeded. Failures here mean
  // orphaned files (wasted storage) but never rows pointing at 404s.
  for (const key of thumbnailKeys) {
    try {
      await deleteFile("public", key);
      logger.info({ comicId, key }, "Deleted comic thumbnail from R2");
    } catch (error) {
      logger.warn(
        { error, comicId, key },
        "Failed to delete comic thumbnail from R2 after DB delete — orphaned file"
      );
    }
  }

  for (const key of pageAssetKeys) {
    try {
      await deleteFile("public", key);
      logger.info({ comicId, key }, "Deleted page asset from R2");
    } catch (error) {
      logger.warn(
        { error, comicId, key },
        "Failed to delete page asset from R2 after DB delete — orphaned file"
      );
    }
  }

  for (const key of videoKeys) {
    try {
      await deleteFile("public", key);
      logger.info({ comicId, key }, "Deleted comic preview video from R2");
    } catch (error) {
      logger.warn(
        { error, comicId, key },
        "Failed to delete comic preview video from R2 after DB delete — orphaned file"
      );
    }
  }

  logger.info(
    {
      comicId,
      thumbnailCount: thumbnailKeys.length,
      pageAssetCount: pageAssetKeys.length,
      videoCount: videoKeys.length,
    },
    "Comic deleted (pages + bubbles cascade-deleted, R2 assets swept)"
  );
}

export const updateComicPricing = async (
  comicId: string,
  data: UpdateComicPricingInput
) => {
  try {
    logger.info(
      { comicId },
      "Executing full-replace of comic pricing rules..."
    );

    const updatedComic = await prisma.$transaction(async (tx) => {
      const existingComic = await tx.comic.findUnique({
        where: { id: comicId },
      });

      if (!existingComic) {
        throw new NotFoundError("Comic not found.");
      }

      await tx.pricingRule.deleteMany({
        where: { comicId },
      });

      await tx.pricingRule.createMany({
        data: data.pricing.map((p) => ({
          comicId,
          countryId: p.countryId,
          coverType: p.coverType,
          mrp: p.mrp,
          price: p.price,
        })),
      });

      return tx.comic.findUnique({
        where: { id: comicId },
        include: { pricingRules: true },
      });
    });

    logger.info({ comicId }, "Successfully replaced comic pricing rules");
    return updatedComic;
  } catch (error: any) {
    logger.error({ err: error, comicId }, "Failed to replace pricing rules");
    throw error;
  }
};

export const getComicPricing = async (comicId: string) => {
  try {
    logger.debug({ comicId }, "Fetching pricing rules for comic...");

    const comicExists = await prisma.comic.findUnique({
      where: { id: comicId },
      select: { id: true },
    });

    if (!comicExists) {
      throw new NotFoundError("Comic not found.");
    }

    const pricingRules = await prisma.pricingRule.findMany({
      where: { comicId },
      include: {
        country: {
          select: {
            id: true,
            name: true,
            code: true,
            currencyCode: true,
            flagUrl: true,
          },
        },
      },
      orderBy: {
        country: {
          name: "asc",
        },
      },
    });

    return pricingRules;
  } catch (error: any) {
    logger.error(
      { err: error, comicId },
      "Failed to fetch comic pricing rules"
    );
    throw error;
  }
};

export const updateComicStatus = async (
  comicId: string,
  data: UpdateComicStatusInput
) => {
  try {
    logger.info(
      { comicId, targetStatus: data.status },
      "Attempting to update comic status..."
    );

    const comic = await prisma.comic.findUnique({
      where: { id: comicId },
      include: { pricingRules: true },
    });

    if (!comic) {
      throw new NotFoundError("Comic not found.");
    }

    if (data.status === "PUBLISHED") {
      if (comic.coverThumbnailUrls.length === 0) {
        throw new ValidationError(
          "Cannot publish comic: at least one cover thumbnail is required."
        );
      }

      if (comic.pricingRules.length === 0) {
        throw new ValidationError(
          "Cannot publish comic: At least one pricing rule is required."
        );
      }
    }

    const updatedComic = await prisma.comic.update({
      where: { id: comicId },
      data: { status: data.status },
    });

    logger.info(
      { comicId, newStatus: updatedComic.status },
      "Successfully updated comic status"
    );
    return updatedComic;
  } catch (error: any) {
    logger.error({ err: error, comicId }, "Failed to update comic status");
    throw error;
  }
};

/**
 * Gender / age / theme filters, shared by the public and admin lists.
 *
 * Each filter is a list. Within one filter a comic matches if it has ANY of
 * the values (`hasSome` / `some`); across filters every given filter must
 * match, because they are separate keys of the same where object.
 */
const buildTagFilters = (
  filters: ComicFilterQueryInput | AdminComicFilterQueryInput
): Prisma.ComicWhereInput => {
  const where: Prisma.ComicWhereInput = {};

  if (filters.gender?.length) {
    where.genderTags = { hasSome: filters.gender };
  }

  if (filters.ageGroup?.length) {
    where.ageGroups = { hasSome: filters.ageGroup };
  }

  if (filters.themeId?.length) {
    where.themes = { some: { id: { in: filters.themeId } } };
  }

  return where;
};

export const getPublicComicsList = async (filters: ComicFilterQueryInput) => {
  const where: Prisma.ComicWhereInput = {
    status: "PUBLISHED",
    ...buildTagFilters(filters),
  };

  if (filters.search !== undefined && filters.search.trim() !== "") {
    where.title = {
      contains: filters.search.trim(),
      mode: "insensitive",
    };
  }

  return await prisma.comic.findMany({
    where,
    select: {
      id: true,
      title: true,
      description: true,
      genderTags: true,
      ageGroups: true,
      isBestseller: true,
      pageCount: true,
      coverThumbnailUrls: true,
      themes: THEMES_SELECT,
      pricingRules: {
        select: {
          mrp: true,
          price: true,
          coverType: true,
          country: {
            select: {
              code: true,
              name: true,
              flagUrl: true,
              currencyCode: true,
            },
          },
        },
      },
    },
    // Bestsellers first, then everything else; newest first within each
    // group. `desc` on a boolean puts true before false. This single ordering
    // drives every storefront listing — the home page grid, /comic, and the
    // "Explore More Books" picks on a comic page — so they always agree.
    orderBy: [{ isBestseller: "desc" }, { createdAt: "desc" }],
  });
};

export const getPublicComicDetails = async (comicId: string) => {
  const comic = await prisma.comic.findFirst({
    where: {
      id: comicId,
      status: "PUBLISHED",
    },
    select: {
      id: true,
      title: true,
      description: true,
      genderTags: true,
      ageGroups: true,
      isBestseller: true,
      pageCount: true,
      freePreviewPages: true,
      coverThumbnailUrls: true,
      // Optional. Null for most comics — the carousel renders images only then.
      // Deliberately NOT added to getPublicComicsList: the video is a
      // detail-page asset and catalogue payloads should not carry it.
      previewVideoUrl: true,
      // SEO overrides. Null on most comics — the page then falls back to
      // `title` / `description`, which are already selected above.
      metaTitle: true,
      metaDescription: true,
      // Rotating lines for the generation screens. Active only — a fact the
      // admin switched off must not reach the browser at all, since ordering is
      // decided client-side and anything sent could be displayed.
      //
      // Ships on this endpoint rather than a dedicated one because the preview
      // page already fetches this comic, so the facts cost no extra request.
      facts: {
        where: { isActive: true },
        select: {
          id: true,
          placement: true,
          text: true,
        },
        orderBy: { createdAt: "asc" },
      },
      themes: THEMES_SELECT,
      pricingRules: {
        select: {
          coverType: true,
          mrp: true,
          price: true,
          country: {
            select: {
              code: true,
              name: true,
              flagUrl: true,
              currencyCode: true,
            },
          },
        },
      },
      pages: {
        where: { isPreviewPage: true },
        orderBy: { pageNumber: "asc" },
        select: {
          id: true,
          pageNumber: true,
          artworkUrl: true,
          // Lets the frontend reserve the correct aspect-ratio box before the
          // preview image loads, avoiding layout shift in the carousel.
          artworkWidth: true,
          artworkHeight: true,
        },
      },
    },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found or not available.");
  }

  return comic;
};

const LORA_UPLOAD_EXPIRY_SECONDS = 60 * 60;

export const getLoraUploadUrl = async (input: GetLoraUploadUrlInput) => {
  const safeFileName = input.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `comics/lora/${Date.now()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "private",
    key,
    "application/octet-stream",
    LORA_UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated LoRA upload URL");

  return { uploadUrl, key };
};

export async function getAdminComicsList(filters: AdminComicFilterQueryInput) {
  const where: Prisma.ComicWhereInput = buildTagFilters(filters);

  if (filters.search !== undefined && filters.search.trim() !== "") {
    where.title = {
      contains: filters.search.trim(),
      mode: "insensitive",
    };
  }

  const comics = await prisma.comic.findMany({
    where,
    include: {
      themes: THEMES_SELECT,
      _count: {
        select: {
          pages: true,
          orderSessions: true,
          pricingRules: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return comics;
}

export const getAdminComicDetail = async (comicId: string) => {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    include: {
      themes: THEMES_SELECT,
      pages: {
        orderBy: { pageNumber: "asc" },
        include: {
          bubbles: {
            orderBy: { sortOrder: "asc" },
          },
        },
      },
      fonts: true,
      pricingRules: {
        include: {
          country: {
            select: {
              id: true,
              code: true,
              name: true,
              currencyCode: true,
              flagUrl: true,
            },
          },
        },
        orderBy: {
          country: {
            name: "asc",
          },
        },
      },
      _count: {
        select: {
          orderSessions: true,
        },
      },
    },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found.");
  }

  logger.info({ comicId }, "Admin fetched comic detail");

  return comic;
};


export const generateThumbnailUploadUrlsBatch = async (
  files: UploadThumbnailsBatchInput["files"]
) => {
  logger.info(
    { count: files.length },
    "Generating batch of thumbnail upload URLs"
  );

  const uploads = await Promise.all(
    files.map((f) => generateThumbnailUploadUrl(f.fileName, f.contentType))
  );

  return { uploads };
};