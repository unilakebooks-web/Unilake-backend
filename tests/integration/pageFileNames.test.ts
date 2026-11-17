// Integration tests for the stored original file names of a page's artwork and
// mask: stored with the file, replaced or cleared only when the file changes,
// kept when the same file is sent again. They run against the Neon TEST branch
// (the setup import refuses any other database) and the local MinIO bucket,
// with real PNGs, because creating and updating a page measures the image.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prisma } from "../../src/lib/prisma.js";
import { createPage, updatePage } from "../../src/services/page.service.js";
import {
  deleteFile,
  downloadFileToBuffer,
  uploadFile,
} from "../../src/lib/r2.js";
import { ValidationError } from "../../src/utils/errors.js";
import {
  createPageSchema,
  updatePageSchema,
} from "../../src/validators/page.schema.js";

const COMIC_ID = "00000000-0000-4000-8000-000000000100";
const RUN = Math.random().toString(36).slice(2, 8);
// Page numbers the seed data does not use; each test takes its own.
const FIRST_PAGE_NUMBER = 90;
let nextPageNumber = FIRST_PAGE_NUMBER;

const keys: string[] = [];
const pageIds: string[] = [];

/** Uploads a real PNG of the given size and returns its storage key. */
async function putPng(label: string, width: number, height: number) {
  const key = `comics/${COMIC_ID}/pages/artwork/__vitest__-${RUN}-${label}.png`;
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .png()
    .toBuffer();
  await uploadFile("public", key, buffer, "image/png");
  keys.push(key);
  return key;
}

async function newPage(input: Record<string, unknown> = {}) {
  const page = await createPage(
    COMIC_ID,
    createPageSchema.parse({ pageNumber: nextPageNumber++, ...input })
  );
  pageIds.push(page.id);
  return page;
}

async function read(pageId: string) {
  return prisma.page.findUniqueOrThrow({ where: { id: pageId } });
}

// A crashed earlier run may have left its pages behind (fixed page numbers).
beforeAll(async () => {
  await prisma.page.deleteMany({
    where: { comicId: COMIC_ID, pageNumber: { gte: FIRST_PAGE_NUMBER } },
  });
});

async function exists(key: string) {
  try {
    await downloadFileToBuffer("public", key);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await prisma.page.deleteMany({ where: { id: { in: pageIds } } });
  for (const key of keys) {
    try {
      await deleteFile("public", key);
    } catch {
      // best effort: a missing object is fine
    }
  }
  await prisma.$disconnect();
});

describe("creating a page", () => {
  it("stores the names together with the files", async () => {
    const art = await putPng("c1-art", 40, 60);
    const mask = await putPng("c1-mask", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      artworkFileName: "page-01 artwork.png",
      maskUrl: mask,
      maskFileName: "page-01-mask.png",
    });
    const row = await read(page.id);
    expect(row.artworkFileName).toBe("page-01 artwork.png");
    expect(row.maskFileName).toBe("page-01-mask.png");
  });

  it("stores no name when none is sent", async () => {
    const art = await putPng("c2-art", 40, 60);
    const page = await newPage({ artworkUrl: art });
    const row = await read(page.id);
    expect(row.artworkFileName).toBeNull();
    expect(row.maskFileName).toBeNull();
  });

  it("ignores a name that comes without a file", async () => {
    const page = await newPage({ artworkFileName: "orphan.png" });
    expect((await read(page.id)).artworkFileName).toBeNull();
  });
});

describe("updating a page", () => {
  it("stores the name of a FIRST upload on a page that had no file", async () => {
    const page = await newPage();
    const art = await putPng("u1-art", 40, 60);
    await updatePage(
      page.id,
      updatePageSchema.parse({ artworkUrl: art, artworkFileName: "first.png" })
    );
    expect((await read(page.id)).artworkFileName).toBe("first.png");
  });

  it("stores the name of a first mask on a page that has artwork", async () => {
    const art = await putPng("u2-art", 40, 60);
    const page = await newPage({ artworkUrl: art, artworkFileName: "a.png" });
    const mask = await putPng("u2-mask", 40, 60);
    await updatePage(
      page.id,
      updatePageSchema.parse({ maskUrl: mask, maskFileName: "first-mask.png" })
    );
    const row = await read(page.id);
    expect(row.maskFileName).toBe("first-mask.png");
    expect(row.artworkFileName).toBe("a.png");
  });

  it("replaces the name when the file is replaced", async () => {
    const art = await putPng("u3-art", 40, 60);
    const page = await newPage({ artworkUrl: art, artworkFileName: "old.png" });
    const art2 = await putPng("u3-art2", 40, 60);
    await updatePage(
      page.id,
      updatePageSchema.parse({ artworkUrl: art2, artworkFileName: "new.png" })
    );
    expect((await read(page.id)).artworkFileName).toBe("new.png");
  });

  it("clears the name when the file is replaced and no name is sent", async () => {
    const art = await putPng("u4-art", 40, 60);
    const page = await newPage({ artworkUrl: art, artworkFileName: "old.png" });
    const art2 = await putPng("u4-art2", 40, 60);
    await updatePage(page.id, updatePageSchema.parse({ artworkUrl: art2 }));
    expect((await read(page.id)).artworkFileName).toBeNull();
  });

  it("keeps the name when the same file is sent again, even with another name", async () => {
    const art = await putPng("u5-art", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      artworkFileName: "kept.png",
    });
    await updatePage(
      page.id,
      updatePageSchema.parse({ artworkUrl: art, artworkFileName: "other.png" })
    );
    expect((await read(page.id)).artworkFileName).toBe("kept.png");
  });

  it("leaves names alone on an update that touches neither file", async () => {
    const art = await putPng("u6-art", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      artworkFileName: "kept.png",
    });
    await updatePage(page.id, updatePageSchema.parse({ hasFace: true }));
    expect((await read(page.id)).artworkFileName).toBe("kept.png");
  });

  it("ignores a name sent without a file", async () => {
    const art = await putPng("u7-art", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      artworkFileName: "kept.png",
    });
    await updatePage(
      page.id,
      updatePageSchema.parse({ hasFace: true, artworkFileName: "sneaky.png" })
    );
    expect((await read(page.id)).artworkFileName).toBe("kept.png");
  });

  it("an empty name alone passes validation and changes nothing", async () => {
    const art = await putPng("u8-art", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      artworkFileName: "kept.png",
    });
    const input = updatePageSchema.parse({ artworkFileName: "" });
    await expect(updatePage(page.id, input)).resolves.toBeDefined();
    expect((await read(page.id)).artworkFileName).toBe("kept.png");
  });

  it("a rejected mask size does not store its name", async () => {
    const art = await putPng("u9-art", 40, 60);
    const page = await newPage({ artworkUrl: art, artworkFileName: "a.png" });
    const wrongMask = await putPng("u9-mask", 20, 20);
    await expect(
      updatePage(
        page.id,
        updatePageSchema.parse({
          maskUrl: wrongMask,
          maskFileName: "wrong-size.png",
        })
      )
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await read(page.id)).maskFileName).toBeNull();
  });
});

describe("replacing a mask follows the same rules as artwork", () => {
  it("replaces the mask name when the mask is replaced", async () => {
    const art = await putPng("m1-art", 40, 60);
    const mask = await putPng("m1-mask", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      maskUrl: mask,
      maskFileName: "old-mask.png",
    });
    const mask2 = await putPng("m1-mask2", 40, 60);
    await updatePage(
      page.id,
      updatePageSchema.parse({ maskUrl: mask2, maskFileName: "new-mask.png" })
    );
    expect((await read(page.id)).maskFileName).toBe("new-mask.png");
  });

  it("clears the mask name when the mask is replaced and no name is sent", async () => {
    const art = await putPng("m2-art", 40, 60);
    const mask = await putPng("m2-mask", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      maskUrl: mask,
      maskFileName: "old-mask.png",
    });
    const mask2 = await putPng("m2-mask2", 40, 60);
    await updatePage(page.id, updatePageSchema.parse({ maskUrl: mask2 }));
    expect((await read(page.id)).maskFileName).toBeNull();
  });

  it("keeps the mask name when the same mask is sent again", async () => {
    const art = await putPng("m3-art", 40, 60);
    const mask = await putPng("m3-mask", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      maskUrl: mask,
      maskFileName: "kept-mask.png",
    });
    await updatePage(
      page.id,
      updatePageSchema.parse({ maskUrl: mask, maskFileName: "other.png" })
    );
    expect((await read(page.id)).maskFileName).toBe("kept-mask.png");
  });

  it("ignores a mask name that comes without a mask", async () => {
    const art = await putPng("m4-art", 40, 60);
    const page = await newPage({
      artworkUrl: art,
      maskFileName: "orphan-mask.png",
    });
    expect((await read(page.id)).maskFileName).toBeNull();
  });
});

describe("the old file after a replace", () => {
  it("is deleted from storage when the file is replaced", async () => {
    const art = await putPng("d1-art", 40, 60);
    const page = await newPage({ artworkUrl: art, artworkFileName: "old.png" });
    const art2 = await putPng("d1-art2", 40, 60);
    await updatePage(page.id, updatePageSchema.parse({ artworkUrl: art2 }));
    expect(await exists(art)).toBe(false);
    expect(await exists(art2)).toBe(true);
  });

  it("is kept when the same file is sent again", async () => {
    const art = await putPng("d2-art", 40, 60);
    const page = await newPage({ artworkUrl: art });
    await updatePage(
      page.id,
      updatePageSchema.parse({ artworkUrl: art, artworkFileName: "x.png" })
    );
    expect(await exists(art)).toBe(true);
  });
});

describe("the name as a display value", () => {
  const segments = (value: string | undefined) =>
    Array.from(new Intl.Segmenter().segment(value ?? "")).length;
  const parse = (name: unknown) =>
    createPageSchema.parse({ pageNumber: 1, artworkFileName: name })
      .artworkFileName;

  it("removes control characters including NUL and trims", () => {
    expect(parse("  a\u0000b\u0007c\n  ")).toBe("abc");
  });

  it("cuts at 255 visible characters: 255 stay, 256 are cut", () => {
    expect(segments(parse("x".repeat(255)))).toBe(255);
    expect(segments(parse("x".repeat(256)))).toBe(255);
    expect(segments(parse("x".repeat(400)))).toBe(255);
  });

  it("never splits an emoji or a Hindi conjunct at the cut", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(parse("x".repeat(255) + family)).toBe("x".repeat(255));
    expect(parse("x".repeat(254) + family)).toBe("x".repeat(254) + family);
    const hindi = parse("\u092A\u0943\u0937\u094D\u0920".repeat(200)) ?? "";
    expect(segments(hindi)).toBe(255);
    expect(hindi.endsWith("\u0943") || hindi.endsWith("\u0920")).toBe(true);
  });

  it("treats a value that is not a string as no name instead of failing", () => {
    for (const bad of [null, 12, true, {}, ["a"]]) {
      expect(parse(bad)).toBeUndefined();
    }
    expect(
      updatePageSchema.parse({ hasFace: true, artworkFileName: null })
    ).toEqual({
      hasFace: true,
      artworkFileName: undefined,
    });
  });

  it("replaces a lone surrogate so the value can always be stored", () => {
    const value = parse("bad\ud800name.png") ?? "";
    expect(value.isWellFormed()).toBe(true);
    expect(value.startsWith("bad")).toBe(true);
  });

  it("removes bidi overrides and zero-width spaces but keeps joiners", () => {
    expect(parse("ab\u202Egpj\u200B.png")).toBe("abgpj.png");
    expect(parse("a\u200Db")).toBe("a\u200Db");
  });

  it("treats an empty or whitespace-only name as no name", () => {
    expect(parse("  \n ")).toBeUndefined();
    expect(
      updatePageSchema.parse({ artworkFileName: "" }).artworkFileName
    ).toBeUndefined();
  });

  it("keeps a name that looks like markup as plain text", () => {
    expect(parse(`<img src=x onerror=alert(1)>.png`)).toBe(
      `<img src=x onerror=alert(1)>.png`
    );
  });
});
