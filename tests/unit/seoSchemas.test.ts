import { describe, it, expect } from "vitest";
import {
  getPageSeoUploadUrlSchema,
  pageSeoSlugParamSchema,
  upsertPageSeoSchema,
} from "../../src/validators/pageSeo.schema.js";
import {
  createBlogSchema,
  updateBlogSchema,
} from "../../src/validators/blog.schema.js";
import { sitePageSlugParamSchema } from "../../src/validators/sitePage.schema.js";
import { updateSiteSettingSchema } from "../../src/validators/siteSetting.schema.js";
import {
  createTeamMemberSchema,
  updateTeamMemberSchema,
} from "../../src/validators/teamMember.schema.js";
import {
  createHeroImageSchema,
  updateHeroImageSchema,
} from "../../src/validators/heroImage.schema.js";
import { updateHowItWorksSchema } from "../../src/validators/howItWorks.schema.js";

const UUID = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const blogBase = { title: "A post", body: "<p>Hello</p>" };

describe("page SEO slug and body", () => {
  it("accepts all ten pages and nothing else", () => {
    for (const slug of [
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
    ]) {
      expect(pageSeoSlugParamSchema.safeParse(slug).success).toBe(true);
    }
    expect(pageSeoSlugParamSchema.safeParse("FAQ").success).toBe(false);
    expect(pageSeoSlugParamSchema.safeParse("home").success).toBe(false);
  });

  it("applies the shared limits", () => {
    expect(
      upsertPageSeoSchema.safeParse({ metaTitle: "t".repeat(120) }).success
    ).toBe(true);
    expect(
      upsertPageSeoSchema.safeParse({ metaTitle: "t".repeat(121) }).success
    ).toBe(false);
    expect(
      upsertPageSeoSchema.safeParse({ ogTitle: "t".repeat(121) }).success
    ).toBe(false);
    expect(
      upsertPageSeoSchema.safeParse({ metaDescription: "d".repeat(320) })
        .success
    ).toBe(true);
    expect(
      upsertPageSeoSchema.safeParse({ metaDescription: "d".repeat(321) })
        .success
    ).toBe(false);
    expect(
      upsertPageSeoSchema.safeParse({ ogDescription: "d".repeat(321) }).success
    ).toBe(false);
    expect(
      upsertPageSeoSchema.safeParse({ ogImageAlt: "a".repeat(201) }).success
    ).toBe(false);
  });

  it("trims, and turns an empty or blank string into null (clears the field)", () => {
    const parsed = upsertPageSeoSchema.parse({
      metaTitle: "  Hello  ",
      metaDescription: "",
      ogTitle: "   ",
      ogImageKey: null,
    });
    expect(parsed.metaTitle).toBe("Hello");
    expect(parsed.metaDescription).toBeNull();
    expect(parsed.ogTitle).toBeNull();
    expect(parsed.ogImageKey).toBeNull();
    expect(parsed.ogDescription).toBeUndefined();
  });

  it("accepts an empty body (everything optional)", () => {
    expect(upsertPageSeoSchema.safeParse({}).success).toBe(true);
  });

  it("the upload-url body is a copy of the blog one", () => {
    expect(
      getPageSeoUploadUrlSchema.safeParse({
        fileName: "a.webp",
        contentType: "image/webp",
      }).success
    ).toBe(true);
    expect(
      getPageSeoUploadUrlSchema.safeParse({
        fileName: "a.gif",
        contentType: "image/gif",
      }).success
    ).toBe(false);
  });
});

describe("site page slug accepts ABOUT", () => {
  it("accepts the four pages and names ABOUT in the message", () => {
    for (const slug of ["PRIVACY", "TERMS", "REFUND", "ABOUT"]) {
      expect(sitePageSlugParamSchema.safeParse(slug).success).toBe(true);
    }
    const bad = sitePageSlugParamSchema.safeParse("CONTACT");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("ABOUT");
  });
});

describe("blog schemas", () => {
  it("still accept a payload without any new field", () => {
    expect(createBlogSchema.safeParse(blogBase).success).toBe(true);
    expect(updateBlogSchema.safeParse({ title: "New title" }).success).toBe(
      true
    );
  });

  it("accept the new fields on create and update", () => {
    const body = {
      ogTitle: "Share",
      ogDescription: "Share text",
      ogImageKey: "blogs/x.webp",
      coverImageAlt: "A child reading",
      featuredComicIds: [UUID(1), UUID(2)],
    };
    expect(
      createBlogSchema.parse({ ...blogBase, ...body }).featuredComicIds
    ).toEqual([UUID(1), UUID(2)]);
    expect(updateBlogSchema.parse(body).ogImageKey).toBe("blogs/x.webp");
  });

  it("counts a field that is only a new one as a change", () => {
    expect(updateBlogSchema.safeParse({ coverImageAlt: "x" }).success).toBe(
      true
    );
    expect(updateBlogSchema.safeParse({ featuredComicIds: [] }).success).toBe(
      true
    );
    expect(updateBlogSchema.safeParse({}).success).toBe(false);
  });

  it("allows at most 6 featured comics, each once", () => {
    const six = [1, 2, 3, 4, 5, 6].map(UUID);
    expect(updateBlogSchema.safeParse({ featuredComicIds: six }).success).toBe(
      true
    );
    expect(
      updateBlogSchema.safeParse({ featuredComicIds: [...six, UUID(7)] })
        .success
    ).toBe(false);
    expect(
      updateBlogSchema.safeParse({ featuredComicIds: [UUID(1), UUID(1)] })
        .success
    ).toBe(false);
    expect(
      createBlogSchema.safeParse({ ...blogBase, featuredComicIds: ["nope"] })
        .success
    ).toBe(false);
  });

  it("applies the share and alt limits and clears with null or an empty string", () => {
    expect(
      updateBlogSchema.safeParse({ ogTitle: "t".repeat(121) }).success
    ).toBe(false);
    expect(
      updateBlogSchema.safeParse({ ogDescription: "d".repeat(321) }).success
    ).toBe(false);
    expect(
      updateBlogSchema.safeParse({ coverImageAlt: "a".repeat(201) }).success
    ).toBe(false);
    expect(
      updateBlogSchema.parse({ coverImageAlt: "" }).coverImageAlt
    ).toBeNull();
    expect(updateBlogSchema.parse({ ogImageKey: null }).ogImageKey).toBeNull();
  });
});

describe("blog author in the site settings", () => {
  it("accepts the three fields and null to clear them", () => {
    const parsed = updateSiteSettingSchema.parse({
      blogAuthorName: "Asha Rao",
      blogAuthorInstagramUrl: "https://instagram.com/asha",
      blogAuthorLinkedinUrl: null,
    });
    expect(parsed.blogAuthorName).toBe("Asha Rao");
    expect(parsed.blogAuthorLinkedinUrl).toBeNull();
  });

  it("limits the name to 100 characters and rejects an empty name and a bad URL", () => {
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorName: "n".repeat(100) })
        .success
    ).toBe(true);
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorName: "n".repeat(101) })
        .success
    ).toBe(false);
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorName: "" }).success
    ).toBe(false);
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorInstagramUrl: "not a url" })
        .success
    ).toBe(false);
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorLinkedinUrl: "nope" })
        .success
    ).toBe(false);
  });

  it("counts an author field as a change on its own, and an old payload still passes", () => {
    expect(
      updateSiteSettingSchema.safeParse({ blogAuthorName: "A" }).success
    ).toBe(true);
    expect(updateSiteSettingSchema.safeParse({ email: "a@b.co" }).success).toBe(
      true
    );
  });
});

describe("alt text fields", () => {
  it("team member: optional on create and update, max 200, empty becomes null", () => {
    const base = { name: "A", role: "B" };
    expect(createTeamMemberSchema.safeParse(base).success).toBe(true);
    expect(
      createTeamMemberSchema.parse({ ...base, imageAlt: " Asha smiling " })
        .imageAlt
    ).toBe("Asha smiling");
    expect(
      createTeamMemberSchema.safeParse({ ...base, imageAlt: "a".repeat(201) })
        .success
    ).toBe(false);
    expect(updateTeamMemberSchema.parse({ imageAlt: "" }).imageAlt).toBeNull();
    expect(
      updateTeamMemberSchema.safeParse({ imageAlt: "a".repeat(200) }).success
    ).toBe(true);
    expect(
      updateTeamMemberSchema.safeParse({ imageAlt: "a".repeat(201) }).success
    ).toBe(false);
  });

  it("hero image: optional, max 200, empty becomes null", () => {
    expect(
      createHeroImageSchema.safeParse({ imageKey: "hero-images/a.webp" })
        .success
    ).toBe(true);
    expect(
      createHeroImageSchema.parse({ imageKey: "k", imageAlt: "" }).imageAlt
    ).toBeNull();
    expect(
      createHeroImageSchema.safeParse({
        imageKey: "k",
        imageAlt: "a".repeat(201),
      }).success
    ).toBe(false);
  });

  it("hero image update: alt only, max 200, empty becomes null, an empty body is refused", () => {
    expect(
      updateHeroImageSchema.parse({ imageAlt: " A banner " }).imageAlt
    ).toBe("A banner");
    expect(updateHeroImageSchema.parse({ imageAlt: "" }).imageAlt).toBeNull();
    expect(updateHeroImageSchema.parse({ imageAlt: null }).imageAlt).toBeNull();
    expect(
      updateHeroImageSchema.safeParse({ imageAlt: "a".repeat(201) }).success
    ).toBe(false);
    expect(updateHeroImageSchema.safeParse({}).success).toBe(false);
  });

  it("how it works poster: optional, max 200, empty becomes null", () => {
    expect(updateHowItWorksSchema.safeParse({ isActive: true }).success).toBe(
      true
    );
    expect(
      updateHowItWorksSchema.parse({ posterAlt: "A poster" }).posterAlt
    ).toBe("A poster");
    expect(
      updateHowItWorksSchema.parse({ posterAlt: "  " }).posterAlt
    ).toBeNull();
    expect(
      updateHowItWorksSchema.safeParse({ posterAlt: "a".repeat(201) }).success
    ).toBe(false);
  });
});
