// Comic thumbnails and hero slides are shrunk to WebP when they are saved. Runs
// against the Neon TEST branch only (the setup import refuses any other
// database). R2 is stubbed: the "downloaded" file is a real generated image, the
// uploads and deletes are recorded, nothing reaches R2.
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
import { createComic, updateComic } from "../../src/services/comic.service.js";
import {
  createHeroImage,
  deleteHeroImage,
} from "../../src/services/heroImage.service.js";
import { createComicSchema } from "../../src/validators/comic.schema.js";
import { ValidationError } from "../../src/utils/errors.js";

const download = vi.mocked(downloadFileToBuffer);
const upload = vi.mocked(uploadFile);
const remove = vi.mocked(deleteFile);

const MARK = "__vitest_thumbs__";
const RUN = Math.random().toString(36).slice(2, 8);
const BASE = config.r2.publicUrlBase.replace(/\/$/, "");

let countryId: string;
let themeId: string;
let picture: Buffer;
const heroIds: string[] = [];

const makeComic = (thumbnailKeys: string[], label: string) =>
  createComicSchema.parse({
    title: `${MARK} ${RUN} ${label}`,
    pageCount: 10,
    freePreviewPages: 2,
    genderTags: ["UNISEX"],
    ageGroups: ["AGE_3_5"],
    themeIds: [themeId],
    thumbnailKeys,
    pricing: [{ countryId, coverType: "HARDCOVER", mrp: 500, price: 400 }],
  });

async function cleanup() {
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.heroImage.deleteMany({
    where: { id: { in: heroIds } },
  });
}

beforeAll(async () => {
  await cleanup();
  const country = await prisma.country.findFirst({ select: { id: true } });
  if (!country) {
    throw new Error("The test database needs a country (run the seed script).");
  }
  countryId = country.id;
  const theme = await prisma.theme.findFirst({ select: { id: true } });
  if (!theme) {
    throw new Error("The test database needs a theme (run the seed script).");
  }
  themeId = theme.id;
  picture = await sharp({
    create: {
      width: 2400,
      height: 1600,
      channels: 3,
      background: { r: 30, g: 90, b: 200 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
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

const keyOf = (url: string) => url.replace(`${BASE}/`, "");

describe("createComic", () => {
  it("stores each new thumbnail as a WebP and deletes the raw upload after saving", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/a.png", "comics/temp/b.png"], "create")
    );

    expect(comic.coverThumbnailUrls).toHaveLength(2);
    for (const url of comic.coverThumbnailUrls) {
      expect(url).toMatch(
        new RegExp(`^${BASE}/comics/thumbnails/[0-9a-f-]{36}\\.webp$`)
      );
    }
    expect(upload.mock.calls.map((c) => c[3])).toEqual([
      "image/webp",
      "image/webp",
    ]);
    expect(
      await sharp(upload.mock.calls[0]![2] as Buffer).metadata()
    ).toMatchObject({
      format: "webp",
      width: 1200,
    });
    expect(remove.mock.calls.map((c) => c[1]).sort()).toEqual([
      "comics/temp/a.png",
      "comics/temp/b.png",
    ]);

    const saved = await prisma.comic.findUniqueOrThrow({
      where: { id: comic.id },
    });
    expect(saved.coverThumbnailUrls).toEqual(comic.coverThumbnailUrls);
  });

  it("creates nothing and keeps the raw uploads when one thumbnail cannot be read", async () => {
    download.mockImplementation(async (_b, key) => {
      if (key === "comics/temp/bad.png") return Buffer.from("not an image");
      return picture;
    });

    await expect(
      createComic(
        makeComic(["comics/temp/ok.png", "comics/temp/bad.png"], "bad")
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(
      await prisma.comic.count({ where: { title: `${MARK} ${RUN} bad` } })
    ).toBe(0);
    // Only the half-finished optimised file is removed; the admin's uploads stay,
    // so the request can simply be sent again.
    const removed = remove.mock.calls.map((c) => c[1] as string);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^comics\/thumbnails\/.*\.webp$/);
  });

  it("says so when an uploaded file is missing from R2", async () => {
    download.mockRejectedValue(new Error("NoSuchKey"));
    await expect(
      createComic(makeComic(["comics/temp/gone.png"], "missing"))
    ).rejects.toThrow(/not found/i);
    expect(
      await prisma.comic.count({ where: { title: `${MARK} ${RUN} missing` } })
    ).toBe(0);
  });
});

describe("updateComic thumbnails", () => {
  it("optimises only the new upload, keeps the others, and deletes only what was removed", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/first.png"], "update")
    );
    const kept = comic.coverThumbnailUrls[0]!;
    vi.clearAllMocks();
    download.mockImplementation(async () => picture);

    // Add one new file next to the stored one.
    const added = await updateComic(comic.id, {
      thumbnailKeys: [kept, "comics/temp/second.png"],
    });
    expect(download.mock.calls.map((c) => c[1])).toEqual([
      "comics/temp/second.png",
    ]);
    expect(added.coverThumbnailUrls[0]).toBe(kept);
    expect(added.coverThumbnailUrls[1]).toMatch(
      /\/comics\/thumbnails\/.*\.webp$/
    );
    expect(remove.mock.calls.map((c) => c[1])).toEqual([
      "comics/temp/second.png",
    ]);

    // Reorder only: nothing is downloaded, uploaded or deleted.
    vi.clearAllMocks();
    const [first, second] = added.coverThumbnailUrls as [string, string];
    const reordered = await updateComic(comic.id, {
      thumbnailKeys: [second, first],
    });
    expect(reordered.coverThumbnailUrls).toEqual([second, first]);
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    // Remove one: exactly that file is deleted.
    const removedOne = await updateComic(comic.id, { thumbnailKeys: [second] });
    expect(removedOne.coverThumbnailUrls).toEqual([second]);
    expect(remove.mock.calls.map((c) => c[1])).toEqual([keyOf(first)]);
  });

  it("changes nothing when a new thumbnail cannot be read", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/solo.png"], "update-fail")
    );
    const kept = comic.coverThumbnailUrls[0]!;
    download.mockRejectedValue(new Error("NoSuchKey"));

    await expect(
      updateComic(comic.id, { thumbnailKeys: [kept, "comics/temp/gone.png"] })
    ).rejects.toThrow(/not found/i);

    const saved = await prisma.comic.findUniqueOrThrow({
      where: { id: comic.id },
    });
    expect(saved.coverThumbnailUrls).toEqual([kept]);
  });

  it("leaves thumbnails alone when the update does not send them", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/keep.png"], "update-other")
    );
    vi.clearAllMocks();
    const updated = await updateComic(comic.id, { description: "new text" });
    expect(updated.coverThumbnailUrls).toEqual(comic.coverThumbnailUrls);
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("a request that fails after the images were optimised", () => {
  const optimisedOnly = () => remove.mock.calls.map((c) => c[1] as string);

  it("removes the optimised files again on create, and keeps the raw upload for a retry", async () => {
    const input = makeComic(["comics/temp/keepme.png"], "create-db-fails");
    // The pricing row points at a country that does not exist: the save fails.
    input.pricing[0]!.countryId = "00000000-0000-4000-8000-000000000000";

    await expect(createComic(input)).rejects.toThrow();

    expect(await prisma.comic.count({ where: { title: input.title } })).toBe(0);
    const removed = optimisedOnly();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^comics\/thumbnails\/.*\.webp$/);
    expect(removed).not.toContain("comics/temp/keepme.png");
  });

  it("removes the optimised files again on update, and changes nothing", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/base.png"], "update-db-fails")
    );
    const kept = comic.coverThumbnailUrls[0]!;
    vi.clearAllMocks();
    download.mockImplementation(async () => picture);

    await expect(
      updateComic(comic.id, {
        thumbnailKeys: [kept, "comics/temp/extra.png"],
        // A theme that does not exist makes the save fail after the images were done.
        themeIds: ["00000000-0000-4000-8000-000000000000"],
      })
    ).rejects.toBeInstanceOf(ValidationError);

    const removed = optimisedOnly();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^comics\/thumbnails\/.*\.webp$/);
    expect(removed).not.toContain("comics/temp/extra.png");
    const saved = await prisma.comic.findUniqueOrThrow({
      where: { id: comic.id },
    });
    expect(saved.coverThumbnailUrls).toEqual([kept]);
  });

  it("refuses a key that is not a fresh upload, and deletes nothing", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/own.png"], "foreign-key")
    );
    const kept = comic.coverThumbnailUrls[0]!;
    vi.clearAllMocks();

    await expect(
      updateComic(comic.id, {
        thumbnailKeys: [kept, "sessions/abc/final/page.png"],
      })
    ).rejects.toThrow(/not valid/i);
    await expect(
      createHeroImage({ imageKey: "comics/temp/not-a-slide.png" })
    ).rejects.toThrow(/not valid/i);

    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("hero images", () => {
  it("stores the slide as a WebP and deletes the raw upload after saving", async () => {
    const hero = await createHeroImage({ imageKey: "hero-images/raw-1.png" });
    heroIds.push(hero.id);

    expect(hero.imageUrl).toMatch(
      new RegExp(`^${BASE}/hero-images/[0-9a-f-]{36}\\.webp$`)
    );
    expect(upload.mock.calls[0]![3]).toBe("image/webp");
    expect(remove.mock.calls.map((c) => c[1])).toEqual([
      "hero-images/raw-1.png",
    ]);

    // Deleting the slide removes the optimised file (the stored URL's key).
    vi.clearAllMocks();
    await deleteHeroImage(hero.id);
    expect(remove.mock.calls.map((c) => c[1])).toEqual([keyOf(hero.imageUrl)]);
  });

  it("refuses a key a slide already uses, and keeps its file", async () => {
    const stored = await prisma.heroImage.create({
      data: { imageUrl: `${BASE}/hero-images/legacy-${RUN}.png` },
    });
    heroIds.push(stored.id);

    await expect(
      createHeroImage({ imageKey: `hero-images/legacy-${RUN}.png` })
    ).rejects.toThrow(ValidationError);
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("creates no slide when the upload is missing", async () => {
    const before = await prisma.heroImage.count();
    download.mockRejectedValue(new Error("NoSuchKey"));
    await expect(
      createHeroImage({ imageKey: "hero-images/nope.png" })
    ).rejects.toThrow(/not found/i);
    expect(await prisma.heroImage.count()).toBe(before);
  });
});

describe("a key some book already stores", () => {
  it("is refused as an upload, and nothing is downloaded or deleted", async () => {
    const owner = await createComic(makeComic(["comics/temp/a.png"], "owner"));
    await prisma.comic.update({
      where: { id: owner.id },
      data: { coverThumbnailUrls: [`${BASE}/comics/temp/legacy-${RUN}.png`] },
    });
    vi.clearAllMocks();

    await expect(
      createComic(makeComic([`comics/temp/legacy-${RUN}.png`], "thief"))
    ).rejects.toThrow(ValidationError);
    await expect(
      updateComic(owner.id, {
        thumbnailKeys: [`comics/temp/legacy-${RUN}.png`],
      })
    ).rejects.toThrow(ValidationError);
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      await prisma.comic.count({ where: { title: { contains: "thief" } } })
    ).toBe(0);
  });
});

describe("a thumbnail that is not under the current storage address", () => {
  it("is kept as it is when the comic is edited, and removing it deletes nothing from storage", async () => {
    const comic = await createComic(
      makeComic(["comics/temp/a.png"], "foreign")
    );
    const inline = "data:image/png;base64,AAAA";
    const ours = comic.coverThumbnailUrls[0]!;
    await prisma.comic.update({
      where: { id: comic.id },
      data: { coverThumbnailUrls: [inline, ours] },
    });
    vi.clearAllMocks();
    download.mockImplementation(async () => picture);
    upload.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);

    // Reorder, add one new upload, keep both: the inline one is not mistaken for an upload.
    const added = await updateComic(comic.id, {
      thumbnailKeys: [ours, inline, "comics/temp/new.png"],
    });
    expect(added.coverThumbnailUrls[0]).toBe(ours);
    expect(added.coverThumbnailUrls[1]).toBe(inline);
    expect(added.coverThumbnailUrls[2]).toMatch(
      /comics\/thumbnails\/[0-9a-f-]{36}\.webp$/
    );
    expect(download).toHaveBeenCalledTimes(1);

    // Removing the inline one touches no file in storage.
    vi.clearAllMocks();
    remove.mockResolvedValue(undefined);
    const kept = added.coverThumbnailUrls.filter((u) => u !== inline);
    await updateComic(comic.id, { thumbnailKeys: kept });
    expect(remove).not.toHaveBeenCalled();
  });
});
