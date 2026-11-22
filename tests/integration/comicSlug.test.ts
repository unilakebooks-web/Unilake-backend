// Integration tests for the comic slug (feature 13): generation on create, rename with history,
// the 409 rules, lookup by id, slug and old slug on the public detail, the share and alt fields and
// the shapes of the public and admin responses. They run against the Neon TEST branch only: the
// setup import below refuses any other database. R2 is stubbed; nothing reaches it.
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
import sharp from "sharp";

vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/r2.js")>()),
  downloadFileToBuffer: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import {
  deleteFile,
  downloadFileToBuffer,
  uploadFile,
} from "../../src/lib/r2.js";
import {
  createComic,
  getAdminComicDetail,
  getAdminComicsList,
  getPublicComicDetails,
  getPublicComicsList,
  updateComic,
} from "../../src/services/comic.service.js";
import {
  createComicSchema,
  updateComicSchema,
} from "../../src/validators/comic.schema.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/utils/errors.js";

const download = vi.mocked(downloadFileToBuffer);
const upload = vi.mocked(uploadFile);
const remove = vi.mocked(deleteFile);

const MARK = "__vitest_comicslug__";
const RUN = Math.random().toString(36).slice(2, 8);
const BASE = config.r2.publicUrlBase.replace(/\/$/, "");
// What MARK and RUN become when a title is slugified.
const PREFIX = `vitest-comicslug-${RUN}`;

const ids: string[] = [];
let countryId: string;
let themeId: string;
let picture: Buffer;

const title = (label: string) => `${MARK} ${RUN} ${label}`;

/** A comic written straight to the database (no images), like the comicOrder tests. */
async function make(
  label: string,
  opts: {
    slug?: string | null;
    status?: "PUBLISHED" | "DRAFT" | "UNPUBLISHED";
    retiredAt?: Date;
    covers?: string[];
  } = {}
) {
  const comic = await prisma.comic.create({
    data: {
      title: title(label),
      pageCount: 6,
      freePreviewPages: 2,
      status: opts.status ?? "PUBLISHED",
      ...(opts.retiredAt && { retiredAt: opts.retiredAt }),
      ...(opts.slug !== undefined && { slug: opts.slug }),
      coverThumbnailUrls: opts.covers ?? [],
    },
  });
  ids.push(comic.id);
  return comic;
}

const historyOf = (comicId: string) =>
  prisma.comicSlugHistory
    .findMany({ where: { comicId }, orderBy: { createdAt: "asc" } })
    .then((rows) => rows.map((r) => r.oldSlug));

const patch = (input: unknown) => updateComicSchema.parse(input);

async function cleanup() {
  const rows = await prisma.comic.findMany({
    where: { title: { startsWith: MARK } },
    select: { id: true },
  });
  const all = [...new Set([...ids, ...rows.map((r) => r.id)])];
  await prisma.pricingRule.deleteMany({ where: { comicId: { in: all } } });
  // History rows go with their comic (ON DELETE CASCADE).
  await prisma.comic.deleteMany({ where: { id: { in: all } } });
}

beforeAll(async () => {
  await cleanup();
  const country = await prisma.country.findFirst({ select: { id: true } });
  const theme = await prisma.theme.findFirst({ select: { id: true } });
  if (!country || !theme) {
    throw new Error(
      "The test database needs a country and a theme (run the seed script)."
    );
  }
  countryId = country.id;
  themeId = theme.id;
  picture = await sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: 30, g: 90, b: 200 },
    },
  })
    .png()
    .toBuffer();
});

beforeEach(() => {
  vi.resetAllMocks();
  download.mockImplementation(async () => picture);
  upload.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const createInput = (label: string, extra: Record<string, unknown> = {}) =>
  createComicSchema.parse({
    title: title(label),
    pageCount: 10,
    freePreviewPages: 2,
    genderTags: ["UNISEX"],
    ageGroups: ["AGE_3_5"],
    themeIds: [themeId],
    thumbnailKeys: ["comics/temp/a.png"],
    pricing: [{ countryId, coverType: "HARDCOVER", mrp: 500, price: 400 }],
    ...extra,
  });

async function create(label: string, extra: Record<string, unknown> = {}) {
  const comic = await createComic(createInput(label, extra));
  ids.push(comic.id);
  return comic;
}

describe("create", () => {
  it("generates the slug from the title when none is sent", async () => {
    const comic = await create("Little Train");
    expect(comic.slug).toBe(`${PREFIX}-little-train`);
  });

  it("adds -2 when a comic already has the slug, and -3 after that", async () => {
    const first = await create("Same Name");
    const second = await create("Same Name");
    const third = await create("Same Name");
    expect(first.slug).toBe(`${PREFIX}-same-name`);
    expect(second.slug).toBe(`${PREFIX}-same-name-2`);
    expect(third.slug).toBe(`${PREFIX}-same-name-3`);
  });

  it("does not hand out a slug that is another comic's OLD slug", async () => {
    const comic = await create("Renamed Later");
    await updateComic(comic.id, patch({ slug: `${PREFIX}-moved` }));
    // Its first slug is now only an old address, and still not free.
    const again = await create("Renamed Later");
    expect(again.slug).toBe(`${PREFIX}-renamed-later-2`);
  });

  it("saves a slug the admin typed, lower-cased", async () => {
    const comic = await create("Typed", { slug: `${PREFIX}-Typed-One` });
    expect(comic.slug).toBe(`${PREFIX}-typed-one`);
  });

  it("is a 409 when the typed slug belongs to another comic or to an old address", async () => {
    const other = await create("Owner");
    await expect(create("Clash", { slug: other.slug })).rejects.toBeInstanceOf(
      ConflictError
    );

    await updateComic(other.id, patch({ slug: `${PREFIX}-owner-new` }));
    await expect(
      create("Clash2", { slug: `${PREFIX}-owner` })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("an old payload without the new fields still creates a comic", async () => {
    const comic = await create("Old Payload");
    expect(comic.ogTitle).toBeNull();
    expect(comic.ogImageUrl).toBeNull();
    expect(comic.coverThumbnailAlts).toEqual([]);
  });
});

describe("rename", () => {
  it("writes the old slug to the history in the same save", async () => {
    const comic = await make("Rename One", { slug: `${PREFIX}-rename-one` });
    const saved = await updateComic(
      comic.id,
      patch({ slug: `${PREFIX}-rename-one-b` })
    );
    expect(saved.slug).toBe(`${PREFIX}-rename-one-b`);
    expect(await historyOf(comic.id)).toEqual([`${PREFIX}-rename-one`]);
  });

  it("keeps every old slug through several renames", async () => {
    const comic = await make("Rename Two", { slug: `${PREFIX}-r2-a` });
    await updateComic(comic.id, patch({ slug: `${PREFIX}-r2-b` }));
    await updateComic(comic.id, patch({ slug: `${PREFIX}-r2-c` }));
    expect((await historyOf(comic.id)).sort()).toEqual([
      `${PREFIX}-r2-a`,
      `${PREFIX}-r2-b`,
    ]);
  });

  it("sending the current slug again changes nothing and writes no history", async () => {
    const comic = await make("Rename Same", { slug: `${PREFIX}-same-slug` });
    await updateComic(
      comic.id,
      patch({ slug: `${PREFIX}-SAME-slug`, title: "x" })
    );
    expect(await historyOf(comic.id)).toEqual([]);
  });

  it("is a 409 when the new slug is another comic's current slug", async () => {
    const a = await make("Clash A", { slug: `${PREFIX}-clash-a` });
    const b = await make("Clash B", { slug: `${PREFIX}-clash-b` });
    await expect(
      updateComic(b.id, patch({ slug: a.slug }))
    ).rejects.toBeInstanceOf(ConflictError);
    // Nothing was written: no history row, slug unchanged.
    expect(await historyOf(b.id)).toEqual([]);
    expect(
      (await prisma.comic.findUniqueOrThrow({ where: { id: b.id } })).slug
    ).toBe(b.slug);
  });

  it("is a 409 when the new slug is another comic's OLD slug", async () => {
    const a = await make("Hijack A", { slug: `${PREFIX}-hijack-a` });
    const b = await make("Hijack B", { slug: `${PREFIX}-hijack-b` });
    await updateComic(a.id, patch({ slug: `${PREFIX}-hijack-a2` }));
    await expect(
      updateComic(b.id, patch({ slug: `${PREFIX}-hijack-a` }))
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await historyOf(b.id)).toEqual([]);
  });

  it("allows going back to this comic's own old slug, and removes that history row", async () => {
    const comic = await make("Back", { slug: `${PREFIX}-back-a` });
    await updateComic(comic.id, patch({ slug: `${PREFIX}-back-b` }));
    expect(await historyOf(comic.id)).toEqual([`${PREFIX}-back-a`]);

    const saved = await updateComic(
      comic.id,
      patch({ slug: `${PREFIX}-back-a` })
    );
    expect(saved.slug).toBe(`${PREFIX}-back-a`);
    // back-a is current again (so no longer history); back-b is the old address now.
    expect(await historyOf(comic.id)).toEqual([`${PREFIX}-back-b`]);
  });

  it("a comic with no slug yet (written by the previous backend) gets one without a history row", async () => {
    const comic = await make("Legacy", { slug: null });
    const saved = await updateComic(
      comic.id,
      patch({ slug: `${PREFIX}-legacy` })
    );
    expect(saved.slug).toBe(`${PREFIX}-legacy`);
    expect(await historyOf(comic.id)).toEqual([]);
  });

  it("an update without a slug leaves the slug and history alone", async () => {
    const comic = await make("No Slug Field", {
      slug: `${PREFIX}-no-slug-field`,
    });
    const saved = await updateComic(
      comic.id,
      patch({ title: title("No Slug Field 2") })
    );
    expect(saved.slug).toBe(`${PREFIX}-no-slug-field`);
    expect(await historyOf(comic.id)).toEqual([]);
  });
});

describe("public detail lookup", () => {
  it("finds a comic by id, by slug (any case) and by an old slug, always returning the current slug", async () => {
    const comic = await make("Lookup", { slug: `${PREFIX}-lookup-a` });
    await updateComic(comic.id, patch({ slug: `${PREFIX}-lookup-b` }));

    const byId = await getPublicComicDetails(comic.id);
    const bySlug = await getPublicComicDetails(`${PREFIX}-lookup-b`);
    const byUpper = await getPublicComicDetails(
      `${PREFIX}-LOOKUP-b`.toUpperCase()
    );
    const byOld = await getPublicComicDetails(`${PREFIX}-lookup-a`);

    for (const detail of [byId, bySlug, byUpper, byOld]) {
      expect(detail.id).toBe(comic.id);
      expect(detail.slug).toBe(`${PREFIX}-lookup-b`);
    }
  });

  it("follows a chain of renames: every old slug still resolves", async () => {
    const comic = await make("Chain", { slug: `${PREFIX}-chain-a` });
    await updateComic(comic.id, patch({ slug: `${PREFIX}-chain-b` }));
    await updateComic(comic.id, patch({ slug: `${PREFIX}-chain-c` }));
    expect((await getPublicComicDetails(`${PREFIX}-chain-a`)).slug).toBe(
      `${PREFIX}-chain-c`
    );
    expect((await getPublicComicDetails(`${PREFIX}-chain-b`)).slug).toBe(
      `${PREFIX}-chain-c`
    );
  });

  it("an id of a comic that has no slug still works", async () => {
    const comic = await make("No Slug", { slug: null });
    const detail = await getPublicComicDetails(comic.id);
    expect(detail.id).toBe(comic.id);
    expect(detail.slug).toBeNull();
  });

  it("unknown id, unknown slug and an unused uuid are 404", async () => {
    await expect(
      getPublicComicDetails(`${PREFIX}-nothing-here`)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      getPublicComicDetails("00000000-0000-4000-8000-0000000000ff")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a draft, an unpublished and a retired comic are 404 by id, slug and old slug", async () => {
    const cases = [
      await make("Draft", { slug: `${PREFIX}-draft`, status: "DRAFT" }),
      await make("Unpub", { slug: `${PREFIX}-unpub`, status: "UNPUBLISHED" }),
      await make("Retired", {
        slug: `${PREFIX}-retired`,
        status: "UNPUBLISHED",
        retiredAt: new Date(),
      }),
    ];
    for (const comic of cases) {
      // An old address needs a history row; write it directly (the comic may be retired, which
      // updateComic refuses on purpose).
      await prisma.comicSlugHistory.create({
        data: { oldSlug: `${comic.slug}-old`, comicId: comic.id },
      });
      for (const key of [comic.id, comic.slug!, `${comic.slug}-old`]) {
        await expect(getPublicComicDetails(key), key).rejects.toBeInstanceOf(
          NotFoundError
        );
      }
    }
  });

  it("publishing again brings the same address back", async () => {
    const comic = await make("Republish", {
      slug: `${PREFIX}-republish`,
      status: "UNPUBLISHED",
    });
    await expect(getPublicComicDetails(comic.slug!)).rejects.toBeInstanceOf(
      NotFoundError
    );
    await prisma.comic.update({
      where: { id: comic.id },
      data: { status: "PUBLISHED" },
    });
    expect((await getPublicComicDetails(comic.slug!)).id).toBe(comic.id);
  });
});

describe("response shapes", () => {
  it("the public detail has the new fields and keeps the old ones", async () => {
    const comic = await make("Shape", {
      slug: `${PREFIX}-shape`,
      covers: [
        `${BASE}/comics/thumbnails/one.webp`,
        `${BASE}/comics/thumbnails/two.webp`,
      ],
    });
    await updateComic(
      comic.id,
      patch({
        ogTitle: "Share title",
        ogDescription: "Share text",
        ogImageKey: "comics/og/shape.png",
        coverThumbnailAlts: ["First cover", "Second cover"],
      })
    );
    const d = await getPublicComicDetails(`${PREFIX}-shape`);
    expect(d).toMatchObject({
      id: comic.id,
      slug: `${PREFIX}-shape`,
      ogTitle: "Share title",
      ogDescription: "Share text",
      ogImageUrl: `${BASE}/comics/og/shape.png`,
      coverThumbnailAlts: ["First cover", "Second cover"],
      title: title("Shape"),
    });
    expect(d.updatedAt).toBeInstanceOf(Date); // serialised to an ISO string by JSON
    for (const field of [
      "description",
      "genderTags",
      "ageGroups",
      "isBestseller",
      "pageCount",
      "freePreviewPages",
      "coverThumbnailUrls",
      "previewVideoUrl",
      "metaTitle",
      "metaDescription",
      "facts",
      "themes",
      "pricingRules",
      "pages",
    ]) {
      expect(d, field).toHaveProperty(field);
    }
    // The internal count is not leaked (unchanged behaviour of withRealPageCount).
    expect(d).not.toHaveProperty("_count");
  });

  it("a comic that never had SEO fields returns nulls and an empty alt list", async () => {
    const comic = await make("Plain", { slug: `${PREFIX}-plain` });
    const d = await getPublicComicDetails(comic.id);
    expect(d.ogTitle).toBeNull();
    expect(d.ogDescription).toBeNull();
    expect(d.ogImageUrl).toBeNull();
    expect(d.coverThumbnailAlts).toEqual([]);
  });

  it("the public list adds slug, updatedAt and coverThumbnailAlts to every item", async () => {
    const comic = await make("Listed", {
      slug: `${PREFIX}-listed`,
      covers: [`${BASE}/c.webp`],
    });
    await updateComic(comic.id, patch({ coverThumbnailAlts: ["A cover"] }));
    const list = await getPublicComicsList(
      {} as Parameters<typeof getPublicComicsList>[0]
    );
    const item = list.find((c) => c.id === comic.id)!;
    expect(item.slug).toBe(`${PREFIX}-listed`);
    expect(item.updatedAt).toBeInstanceOf(Date);
    expect(item.coverThumbnailAlts).toEqual(["A cover"]);
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("pricingRules");
  });

  it("the admin detail and list return the new fields", async () => {
    const comic = await make("Admin", { slug: `${PREFIX}-admin-shape` });
    await updateComic(
      comic.id,
      patch({
        ogTitle: "T",
        ogDescription: "D",
        ogImageKey: "comics/og/admin.png",
      })
    );
    const detail = await getAdminComicDetail(comic.id);
    expect(detail).toMatchObject({
      slug: `${PREFIX}-admin-shape`,
      ogTitle: "T",
      ogDescription: "D",
      ogImageUrl: `${BASE}/comics/og/admin.png`,
      coverThumbnailAlts: [],
    });
    const list = await getAdminComicsList({
      search: `${MARK} ${RUN} Admin`,
    } as Parameters<typeof getAdminComicsList>[0]);
    expect(list.find((c) => c.id === comic.id)).toMatchObject({
      slug: `${PREFIX}-admin-shape`,
      ogTitle: "T",
      ogImageUrl: `${BASE}/comics/og/admin.png`,
    });
  });
});

describe("share image and alt text", () => {
  it("replacing the share image deletes the old file after the save", async () => {
    const comic = await make("Og Replace", { slug: `${PREFIX}-og-replace` });
    await updateComic(comic.id, patch({ ogImageKey: "comics/og/one.png" }));
    expect(remove).not.toHaveBeenCalled();

    await updateComic(comic.id, patch({ ogImageKey: "comics/og/two.png" }));
    expect(remove).toHaveBeenCalledWith("public", "comics/og/one.png");
    expect(
      (await prisma.comic.findUniqueOrThrow({ where: { id: comic.id } }))
        .ogImageUrl
    ).toBe(`${BASE}/comics/og/two.png`);
  });

  it("resending the stored key (the admin form resends everything) deletes nothing", async () => {
    const comic = await make("Og Same", { slug: `${PREFIX}-og-same` });
    await updateComic(comic.id, patch({ ogImageKey: "comics/og/keep.png" }));
    await updateComic(comic.id, patch({ ogImageKey: "comics/og/keep.png" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("null clears the share image and deletes the file; omitting it leaves it", async () => {
    const comic = await make("Og Clear", { slug: `${PREFIX}-og-clear` });
    await updateComic(comic.id, patch({ ogImageKey: "comics/og/gone.png" }));
    await updateComic(comic.id, patch({ title: title("Og Clear 2") }));
    expect(remove).not.toHaveBeenCalled();

    await updateComic(comic.id, patch({ ogImageKey: null }));
    expect(remove).toHaveBeenCalledWith("public", "comics/og/gone.png");
    expect(
      (await prisma.comic.findUniqueOrThrow({ where: { id: comic.id } }))
        .ogImageUrl
    ).toBeNull();
  });

  it("a rejected slug change does not delete the old share image", async () => {
    const taken = await make("Og Taken", { slug: `${PREFIX}-og-taken` });
    const comic = await make("Og Safe", { slug: `${PREFIX}-og-safe` });
    await updateComic(comic.id, patch({ ogImageKey: "comics/og/safe.png" }));
    await expect(
      updateComic(
        comic.id,
        patch({ slug: taken.slug, ogImageKey: "comics/og/other.png" })
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(remove).not.toHaveBeenCalledWith("public", "comics/og/safe.png");
  });

  it("empty strings and null clear the share text", async () => {
    const comic = await make("Og Text", { slug: `${PREFIX}-og-text` });
    await updateComic(
      comic.id,
      patch({ ogTitle: "Hello", ogDescription: "World" })
    );
    const saved = await updateComic(
      comic.id,
      patch({ ogTitle: "", ogDescription: null })
    );
    expect(saved.ogTitle).toBeNull();
    expect(saved.ogDescription).toBeNull();
  });

  it("alt texts are saved by position and may not outnumber the covers", async () => {
    const comic = await make("Alts", {
      slug: `${PREFIX}-alts`,
      covers: [`${BASE}/a.webp`, `${BASE}/b.webp`],
    });
    const saved = await updateComic(
      comic.id,
      patch({ coverThumbnailAlts: ["One", ""] })
    );
    expect(saved.coverThumbnailAlts).toEqual(["One", ""]);
    await expect(
      updateComic(comic.id, patch({ coverThumbnailAlts: ["a", "b", "c"] }))
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("alt texts left without a cover are dropped when covers are removed and none are sent", async () => {
    const comic = await make("Alts Trim", {
      slug: `${PREFIX}-alts-trim`,
      covers: [`${BASE}/a.webp`, `${BASE}/b.webp`],
    });
    await updateComic(comic.id, patch({ coverThumbnailAlts: ["One", "Two"] }));
    // Keep only the first cover (a stored URL is "kept", so nothing is uploaded or optimised).
    const saved = await updateComic(
      comic.id,
      patch({ thumbnailKeys: [`${BASE}/a.webp`] })
    );
    expect(saved.coverThumbnailUrls).toEqual([`${BASE}/a.webp`]);
    expect(saved.coverThumbnailAlts).toEqual(["One"]);
  });
});

describe("existing behaviour", () => {
  it("an old-style update payload (no SEO fields) still saves", async () => {
    const comic = await make("Regression", { slug: `${PREFIX}-regression` });
    const saved = await updateComic(
      comic.id,
      patch({
        title: title("Regression 2"),
        metaTitle: "Meta",
        isBestseller: true,
      })
    );
    expect(saved.title).toBe(title("Regression 2"));
    expect(saved.metaTitle).toBe("Meta");
    expect(saved.slug).toBe(`${PREFIX}-regression`);
    expect(upload).not.toHaveBeenCalled();
  });

  it("a retired comic still cannot be updated, slug or not", async () => {
    const comic = await make("Retired Edit", {
      slug: `${PREFIX}-retired-edit`,
      status: "UNPUBLISHED",
      retiredAt: new Date(),
    });
    await expect(
      updateComic(comic.id, patch({ slug: `${PREFIX}-retired-edit-2` }))
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("the detail service still takes a plain id", async () => {
    const comic = await make("By Id", { slug: `${PREFIX}-by-id` });
    expect((await getPublicComicDetails(comic.id)).title).toBe(title("By Id"));
  });
});
