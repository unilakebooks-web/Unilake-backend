// The comic slug rule (src/lib/comicSlug.ts) and the comic validators that use it. No database: the
// "is this slug taken" lookups are faked, so these run anywhere.
import { describe, expect, it } from "vitest";
import {
  COMIC_SLUG_RESERVED,
  generateFreeComicSlug,
  hasControlCharacter,
  isUuidShaped,
  normalizeSlug,
  slugifyTitle,
  validateSlug,
} from "../../src/lib/comicSlug.js";
import {
  createComicSchema,
  getComicOgImageUploadUrlSchema,
  updateComicSchema,
} from "../../src/validators/comic.schema.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("normalizeSlug", () => {
  it("trims and lower-cases", () => {
    expect(normalizeSlug("  My-Book ")).toBe("my-book");
  });
});

describe("validateSlug", () => {
  const ok = [
    "abc",
    "the-alphabet-train",
    "book-2",
    "a1b",
    "x".repeat(80),
    "THE-ALPHABET-TRAIN", // lower-cased before checking
    "  my-book  ",
  ];
  const bad: [string, string, RegExp][] = [
    ["empty", "", /cannot be empty/],
    ["spaces only", "   ", /cannot be empty/],
    ["2 characters", "ab", /at least 3/],
    ["81 characters", "x".repeat(81), /at most 80/],
    ["Devanagari", "कहानी-किताब", /lower case letters/],
    ["accented letters", "café-book", /lower case letters/],
    ["inner space", "my book", /lower case letters/],
    ["underscore", "my_book", /lower case letters/],
    ["double hyphen", "my--book", /single hyphens/],
    ["leading hyphen", "-my-book", /cannot start or end/],
    ["trailing hyphen", "my-book-", /cannot start or end/],
    ["slash", "my/book", /lower case letters/],
    ["uuid shaped", UUID, /look like an id/],
    ["uuid shaped, upper case", UUID.toUpperCase(), /look like an id/],
    ["reserved", "admin", /reserved/],
    ["reserved, upper case", "Preview", /reserved/],
    ["reserved with hyphen", "how-it-works", /reserved/],
    ["reserved with underscore", "_next", /lower case letters|reserved/],
  ];

  it.each(ok)("accepts %j", (value) => {
    expect(validateSlug(value)).toBeNull();
  });

  it.each(bad)("rejects %s", (_name, value, message) => {
    expect(validateSlug(value)).toMatch(message);
  });

  it("rejects every reserved word that is otherwise a valid slug", () => {
    for (const word of COMIC_SLUG_RESERVED) {
      expect(validateSlug(word), word).not.toBeNull();
    }
  });

  it("exactly 80 passes and 81 fails", () => {
    expect(validateSlug("a".repeat(80))).toBeNull();
    expect(validateSlug("a".repeat(81))).not.toBeNull();
  });
});

describe("isUuidShaped", () => {
  it("tells ids from slugs", () => {
    expect(isUuidShaped(UUID)).toBe(true);
    expect(isUuidShaped(UUID.toUpperCase())).toBe(true);
    expect(isUuidShaped("the-alphabet-train")).toBe(false);
    expect(isUuidShaped(`${UUID}-x`)).toBe(false);
  });
});

describe("hasControlCharacter", () => {
  it("finds NUL and the other control characters", () => {
    for (const bad of ["a\u0000b", "\u0000", "a\u001fb", "a\u007f", "a\nb", "a\tb"]) {
      expect(hasControlCharacter(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it("leaves ordinary slugs and ids alone", () => {
    for (const fine of ["the-alphabet-train", UUID, "Book 2", "\u0905\u092c"]) {
      expect(hasControlCharacter(fine), fine).toBe(false);
    }
  });
});

describe("slugifyTitle", () => {
  it("lower-cases and joins words with single hyphens", () => {
    expect(slugifyTitle("The Alphabet Train")).toBe("the-alphabet-train");
    expect(slugifyTitle("  Hello,   World!!  ")).toBe("hello-world");
    expect(slugifyTitle("A & B: the 2nd book")).toBe("a-b-the-2nd-book");
  });

  it("gives an empty string when nothing is left", () => {
    expect(slugifyTitle("कहानी")).toBe("");
    expect(slugifyTitle("!!!")).toBe("");
    expect(slugifyTitle("")).toBe("");
  });

  it("drops accents and non-Latin letters, keeps the rest", () => {
    expect(slugifyTitle("Café Rouge")).toBe("caf-rouge");
    expect(slugifyTitle("Train कहानी 2")).toBe("train-2");
  });

  it("cuts at 80 characters and trims a hyphen left at the cut", () => {
    const long = `${"a".repeat(79)} b`; // the cut lands right after the hyphen
    const slug = slugifyTitle(long);
    expect(slug).toBe("a".repeat(79));
    expect(slugifyTitle("a".repeat(120))).toHaveLength(80);
  });
});

/** A fake database: which slugs comics hold, and which are old addresses. */
function fakeClient(
  comics: Record<string, string>,
  history: Record<string, string>
) {
  return {
    comic: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        comics[where.slug] ? { id: comics[where.slug] } : null,
    },
    comicSlugHistory: {
      findUnique: async ({ where }: { where: { oldSlug: string } }) =>
        history[where.oldSlug] ? { comicId: history[where.oldSlug] } : null,
    },
  } as unknown as Parameters<typeof generateFreeComicSlug>[0];
}

describe("generateFreeComicSlug", () => {
  it("uses the slugified title when it is free", async () => {
    expect(
      await generateFreeComicSlug(fakeClient({}, {}), "The Alphabet Train")
    ).toBe("the-alphabet-train");
  });

  it("adds -2, -3 when a comic holds the slug", async () => {
    const client = fakeClient({ "my-book": "a", "my-book-2": "b" }, {});
    expect(await generateFreeComicSlug(client, "My Book")).toBe("my-book-3");
  });

  it("treats an old slug as taken", async () => {
    const client = fakeClient(
      { "my-book": "a" },
      { "my-book-2": "a", "my-book-3": "b" }
    );
    expect(await generateFreeComicSlug(client, "My Book")).toBe("my-book-4");
  });

  it("falls back to comic, comic-2 for a title with nothing usable", async () => {
    expect(await generateFreeComicSlug(fakeClient({}, {}), "कहानी")).toBe(
      "comic"
    );
    expect(
      await generateFreeComicSlug(fakeClient({ comic: "a" }, {}), "कहानी")
    ).toBe("comic-2");
    expect(
      await generateFreeComicSlug(
        fakeClient({ comic: "a" }, { "comic-2": "b" }),
        ""
      )
    ).toBe("comic-3");
  });

  it("falls back to comic when the title slugifies to a too-short, reserved or id-shaped word", async () => {
    const client = fakeClient({}, {});
    expect(await generateFreeComicSlug(client, "ab")).toBe("comic");
    expect(await generateFreeComicSlug(client, "About")).toBe("comic");
    expect(await generateFreeComicSlug(client, UUID)).toBe("comic");
  });

  it("keeps base plus suffix within 80 characters", async () => {
    const long = "a".repeat(100);
    const client = fakeClient({ [`${"a".repeat(80)}`]: "x" }, {});
    const slug = await generateFreeComicSlug(client, long);
    expect(slug).toBe(`${"a".repeat(78)}-2`);
    expect(slug).toHaveLength(80);
    expect(validateSlug(slug)).toBeNull();
  });

  it("gives up with a 409 instead of looping for ever", async () => {
    const everything = {
      comic: { findUnique: async () => ({ id: "x" }) },
      comicSlugHistory: { findUnique: async () => null },
    } as unknown as Parameters<typeof generateFreeComicSlug>[0];
    await expect(
      generateFreeComicSlug(everything, "My Book")
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("comic validators: slug", () => {
  const create = {
    title: "My Book",
    genderTags: ["UNISEX"],
    pageCount: 10,
    freePreviewPages: 2,
    thumbnailKeys: ["comics/temp/a.png"],
    pricing: [
      { countryId: UUID, coverType: "HARDCOVER", mrp: 500, price: 400 },
    ],
    themeIds: [UUID],
    ageGroups: ["AGE_3_5"],
  };
  const messages = (r: { error?: { issues: { message: string }[] } }) =>
    r.error?.issues.map((i) => i.message) ?? [];

  it("create works without a slug (old payloads)", () => {
    const r = createComicSchema.safeParse(create);
    expect(r.success).toBe(true);
    expect(r.data?.slug).toBeUndefined();
  });

  it("create normalises a given slug", () => {
    expect(createComicSchema.parse({ ...create, slug: " My-Book " }).slug).toBe(
      "my-book"
    );
  });

  it("create rejects a bad slug with the reason", () => {
    expect(
      messages(createComicSchema.safeParse({ ...create, slug: "admin" }))[0]
    ).toMatch(/reserved/);
    expect(
      messages(createComicSchema.safeParse({ ...create, slug: UUID }))[0]
    ).toMatch(/look like an id/);
    expect(createComicSchema.safeParse({ ...create, slug: "" }).success).toBe(
      false
    );
    expect(createComicSchema.safeParse({ ...create, slug: null }).success).toBe(
      false
    );
  });

  it("update accepts a slug and normalises it", () => {
    expect(updateComicSchema.parse({ slug: "New-Name" }).slug).toBe("new-name");
  });

  it("update refuses to clear the slug", () => {
    expect(updateComicSchema.safeParse({ slug: null }).success).toBe(false);
    expect(updateComicSchema.safeParse({ slug: "" }).success).toBe(false);
    expect(updateComicSchema.safeParse({ slug: "  " }).success).toBe(false);
  });

  it("update still accepts the old payloads", () => {
    expect(updateComicSchema.safeParse({ title: "x" }).success).toBe(true);
    expect(updateComicSchema.safeParse({ metaTitle: null }).success).toBe(true);
    expect(updateComicSchema.safeParse({}).success).toBe(false); // at least one field, as before
  });
});

describe("comic validators: share and alt fields", () => {
  it("trims and turns an empty string or null into null", () => {
    const r = updateComicSchema.parse({
      ogTitle: "  Share me  ",
      ogDescription: "   ",
      ogImageKey: "",
    });
    expect(r.ogTitle).toBe("Share me");
    expect(r.ogDescription).toBeNull();
    expect(r.ogImageKey).toBeNull();
    expect(updateComicSchema.parse({ ogTitle: null }).ogTitle).toBeNull();
  });

  it("limits: ogTitle 120, ogDescription 320, alt 200", () => {
    expect(
      updateComicSchema.safeParse({ ogTitle: "t".repeat(120) }).success
    ).toBe(true);
    expect(
      updateComicSchema.safeParse({ ogTitle: "t".repeat(121) }).success
    ).toBe(false);
    expect(
      updateComicSchema.safeParse({ ogDescription: "d".repeat(320) }).success
    ).toBe(true);
    expect(
      updateComicSchema.safeParse({ ogDescription: "d".repeat(321) }).success
    ).toBe(false);
    expect(
      updateComicSchema.safeParse({ coverThumbnailAlts: ["a".repeat(200)] })
        .success
    ).toBe(true);
    expect(
      updateComicSchema.safeParse({ coverThumbnailAlts: ["a".repeat(201)] })
        .success
    ).toBe(false);
  });

  it("alt texts are trimmed, keep their positions and at most 10", () => {
    expect(
      updateComicSchema.parse({ coverThumbnailAlts: [" one ", "", "three"] })
        .coverThumbnailAlts
    ).toEqual(["one", "", "three"]);
    expect(
      updateComicSchema.safeParse({ coverThumbnailAlts: Array(11).fill("a") })
        .success
    ).toBe(false);
    expect(
      updateComicSchema.safeParse({ coverThumbnailAlts: [] }).success
    ).toBe(true);
  });

  it("the share image key must be one the upload route issued", () => {
    expect(
      updateComicSchema.safeParse({ ogImageKey: "comics/og/abc-share.png" })
        .success
    ).toBe(true);
    expect(
      updateComicSchema.safeParse({ ogImageKey: "comics/thumbnails/x.webp" })
        .success
    ).toBe(false);
    expect(
      updateComicSchema.safeParse({ ogImageKey: "comics/og/../x.png" }).success
    ).toBe(false);
  });

  it("share image upload url accepts images only", () => {
    expect(
      getComicOgImageUploadUrlSchema.safeParse({
        fileName: "a.png",
        contentType: "image/png",
      }).success
    ).toBe(true);
    expect(
      getComicOgImageUploadUrlSchema.safeParse({
        fileName: "a.gif",
        contentType: "image/gif",
      }).success
    ).toBe(false);
    expect(
      getComicOgImageUploadUrlSchema.safeParse({
        fileName: "",
        contentType: "image/png",
      }).success
    ).toBe(false);
  });
});
