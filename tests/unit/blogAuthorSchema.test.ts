import { describe, it, expect } from "vitest";
import {
  createBlogSchema,
  updateBlogSchema,
} from "../../src/validators/blog.schema.js";

const blogBase = { title: "A post", body: "<p>Hello</p>" };

describe("blog post author fields", () => {
  it("are optional: a post without them is valid and they stay unset", () => {
    const parsed = createBlogSchema.parse(blogBase);
    expect(parsed.authorName).toBeUndefined();
    expect(parsed.authorInstagramUrl).toBeUndefined();
    expect(parsed.authorLinkedinUrl).toBeUndefined();
  });

  it("trim the name and keep http and https links", () => {
    const parsed = createBlogSchema.parse({
      ...blogBase,
      authorName: "  Guest Writer  ",
      authorInstagramUrl: " https://www.instagram.com/guest ",
      authorLinkedinUrl: "http://www.linkedin.com/in/guest",
    });
    expect(parsed.authorName).toBe("Guest Writer");
    expect(parsed.authorInstagramUrl).toBe("https://www.instagram.com/guest");
    expect(parsed.authorLinkedinUrl).toBe("http://www.linkedin.com/in/guest");
  });

  it("turn a blank box into null, so a cleared field clears the column", () => {
    const parsed = updateBlogSchema.parse({
      authorName: "   ",
      authorInstagramUrl: "",
      authorLinkedinUrl: "",
    });
    expect(parsed.authorName).toBeNull();
    expect(parsed.authorInstagramUrl).toBeNull();
    expect(parsed.authorLinkedinUrl).toBeNull();
  });

  it("refuse links that are not web addresses (they become a link on the post)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "instagram.com/guest",
      "ftp://x.test",
    ]) {
      expect(
        createBlogSchema.safeParse({ ...blogBase, authorInstagramUrl: bad })
          .success
      ).toBe(false);
      expect(
        updateBlogSchema.safeParse({ authorLinkedinUrl: bad }).success
      ).toBe(false);
    }
  });

  it("refuse a name over 100 characters", () => {
    expect(
      createBlogSchema.safeParse({ ...blogBase, authorName: "a".repeat(101) })
        .success
    ).toBe(false);
    expect(
      createBlogSchema.safeParse({ ...blogBase, authorName: "a".repeat(100) })
        .success
    ).toBe(true);
  });

  it("count as a field for the 'at least one field' rule of an update", () => {
    expect(updateBlogSchema.safeParse({ authorName: "Guest" }).success).toBe(
      true
    );
  });
});
