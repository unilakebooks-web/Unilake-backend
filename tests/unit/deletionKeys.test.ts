import { describe, it, expect, vi } from "vitest";

// Nothing here may reach a bucket: the configuration is replaced and the logger silenced, so importing
// src/lib/r2.ts only builds an S3 client object that never sends anything.
vi.mock("../../src/config/env.js", () => ({
  config: {
    r2: {
      endpoint: "http://127.0.0.1:1",
      accessKeyId: "test",
      secretAccessKey: "test",
      publicBucket: "public-test",
      privateBucket: "private-test",
      publicUrlBase: "https://media.example.test/",
    },
  },
}));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  publicUrlToKey,
  recordedSessionKeys,
  isInSessionFolder,
} from "../../src/utils/deletionKeys.js";
import {
  isDeletionListPrefix,
  isDeletionKey,
  pdfKeyFor,
} from "../../src/lib/r2.js";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174001";

describe("publicUrlToKey", () => {
  it("strips the configured base (its trailing slash is ignored)", () => {
    expect(
      publicUrlToKey(`https://media.example.test/sessions/${SID}/pages/1.png`)
    ).toBe(`sessions/${SID}/pages/1.png`);
  });
  it("does not accept a host that only starts with the configured base", () => {
    expect(
      publicUrlToKey(
        `https://media.example.test.evil.com/sessions/${SID}/a.png`
      )
    ).toBeNull();
    expect(publicUrlToKey(`https://media.example.testing/a.png`)).toBeNull();
  });
  it("accepts any .r2.dev host", () => {
    expect(
      publicUrlToKey("https://pub-abc123.r2.dev/comics/c1/pages/p.png")
    ).toBe("comics/c1/pages/p.png");
  });
  it("accepts images.unilakekids.com, in any letter case", () => {
    expect(
      publicUrlToKey("https://images.unilakekids.com/sessions/a/b.png")
    ).toBe("sessions/a/b.png");
    expect(
      publicUrlToKey("https://IMAGES.UnilakeKids.com/sessions/a/b.png")
    ).toBe("sessions/a/b.png");
  });
  it("refuses an unknown host", () => {
    expect(publicUrlToKey("https://example.com/sessions/a/b.png")).toBeNull();
    expect(
      publicUrlToKey("https://cdn.unilakekids.com/sessions/a/b.png")
    ).toBeNull();
  });
  it("refuses look-alike hosts", () => {
    for (const url of [
      "https://r2.dev/a.png",
      "https://evil-r2.dev/a.png",
      "https://pub.r2.dev.evil.com/a.png",
      "https://images.unilakekids.com.evil.com/a.png",
      "https://evil.com/images.unilakekids.com/a.png",
      "https://evil.com/.r2.dev/a.png",
    ]) {
      expect(publicUrlToKey(url), url).toBeNull();
    }
  });
  it("refuses text that is not a URL, and the empty string", () => {
    expect(publicUrlToKey("")).toBeNull();
    expect(publicUrlToKey("sessions/a/b.png")).toBeNull();
    expect(publicUrlToKey("not a url")).toBeNull();
  });
  it("decodes percent-encoded characters on the r2.dev and images hosts", () => {
    expect(
      publicUrlToKey("https://pub-1.r2.dev/comics/c1/fonts/My%20Font.ttf")
    ).toBe("comics/c1/fonts/My Font.ttf");
    expect(
      publicUrlToKey(
        "https://images.unilakekids.com/comics/c1/pages/%C3%A9.png"
      )
    ).toBe("comics/c1/pages/é.png");
  });
  it("refuses an invalid percent sequence instead of throwing", () => {
    expect(publicUrlToKey("https://pub-1.r2.dev/a/%E0%A4%A.png")).toBeNull();
  });
  it("ignores the query string and the fragment", () => {
    expect(publicUrlToKey("https://pub-1.r2.dev/a/b.png?v=2#x")).toBe(
      "a/b.png"
    );
  });
  it("an empty path on a host is null", () => {
    expect(publicUrlToKey("https://pub-1.r2.dev")).toBeNull();
    expect(publicUrlToKey("https://pub-1.r2.dev/")).toBeNull();
    expect(publicUrlToKey("https://images.unilakekids.com/")).toBeNull();
  });
  // FINDING: the configured-base branch returns "" (not null) for a URL that is only the base plus "/".
  // The host branch returns null for the same shape. A key of "" would be recorded as a public key.
  it("an empty path after the configured base is null, like on the other hosts", () => {
    expect(publicUrlToKey("https://media.example.test/")).toBeNull();
  });
  // Documents current behaviour: the configured-base branch does not percent-decode, the host branch does.
  it("keeps the configured-base path as written (no decoding)", () => {
    expect(publicUrlToKey("https://media.example.test/a/b%20c.png")).toBe(
      "a/b%20c.png"
    );
  });
});

describe("recordedSessionKeys", () => {
  const url = (path: string) => `https://pub-1.r2.dev/${path}`;
  const version = (
    over: Partial<
      Record<
        "textStampedUrl" | "displayImageUrl" | "finalImageUrl",
        string | null
      >
    > = {}
  ) => ({
    textStampedUrl: null,
    displayImageUrl: null,
    finalImageUrl: null,
    ...over,
  });

  it("returns nothing for an empty session", () => {
    expect(
      recordedSessionKeys({
        rawPhotoUrls: [],
        bestPhotoUrl: null,
        pageVersions: [],
      })
    ).toEqual({
      privateKeys: [],
      publicKeys: [],
      unknownUrls: 0,
    });
  });
  it("collects private keys from raw photos and the best photo, once each", () => {
    const keys = recordedSessionKeys({
      rawPhotoUrls: [
        `sessions/${SID}/photo-1.jpg`,
        "",
        `sessions/${SID}/photo-2.jpg`,
      ],
      bestPhotoUrl: `sessions/${SID}/photo-1.jpg`,
      pageVersions: [],
    });
    expect(keys.privateKeys).toEqual([
      `sessions/${SID}/photo-1.jpg`,
      `sessions/${SID}/photo-2.jpg`,
    ]);
  });
  it("collects the three URLs of every version, FAILED ones included (the type has no status filter)", () => {
    const keys = recordedSessionKeys({
      rawPhotoUrls: [],
      bestPhotoUrl: null,
      pageVersions: [
        version({
          textStampedUrl: url("a/1.png"),
          displayImageUrl: url("a/2.png"),
        }),
        version({ finalImageUrl: url("a/3.png") }),
        version({ textStampedUrl: url("a/4.png") }),
      ],
    });
    expect(keys.publicKeys).toEqual([
      "a/1.png",
      "a/2.png",
      "a/3.png",
      "a/4.png",
    ]);
    expect(keys.unknownUrls).toBe(0);
  });
  it("de-duplicates equal keys across versions and URL fields", () => {
    const keys = recordedSessionKeys({
      rawPhotoUrls: [],
      bestPhotoUrl: null,
      pageVersions: [
        version({
          displayImageUrl: url("a/1.png"),
          finalImageUrl: url("a/1.png"),
        }),
        version({ displayImageUrl: "https://media.example.test/a/1.png" }),
      ],
    });
    expect(keys.publicKeys).toEqual(["a/1.png"]);
  });
  it("counts URLs that are not ours instead of returning them, and skips null or empty URLs", () => {
    const keys = recordedSessionKeys({
      rawPhotoUrls: [],
      bestPhotoUrl: null,
      pageVersions: [
        version({
          textStampedUrl: "https://example.com/x.png",
          displayImageUrl: null,
          finalImageUrl: "",
        }),
        version({ finalImageUrl: "garbage" }),
        version({ finalImageUrl: url("ok.png") }),
      ],
    });
    expect(keys).toEqual({
      privateKeys: [],
      publicKeys: ["ok.png"],
      unknownUrls: 2,
    });
  });
  it("never puts a private key in the public list or the reverse", () => {
    const keys = recordedSessionKeys({
      rawPhotoUrls: ["p/1.jpg"],
      bestPhotoUrl: null,
      pageVersions: [version({ finalImageUrl: url("q/1.png") })],
    });
    expect(keys.privateKeys).toEqual(["p/1.jpg"]);
    expect(keys.publicKeys).toEqual(["q/1.png"]);
  });
});

describe("isInSessionFolder", () => {
  it("is true only inside the session's own folder", () => {
    expect(isInSessionFolder(SID, `sessions/${SID}/a.png`)).toBe(true);
    expect(isInSessionFolder(SID, `sessions/${OTHER}/a.png`)).toBe(false);
    expect(isInSessionFolder(SID, `sessions/${SID}`)).toBe(false);
    expect(isInSessionFolder(SID, `sessions/${SID}x/a.png`)).toBe(false);
  });
});

describe("isDeletionListPrefix", () => {
  it("accepts exactly the engine's prefixes", () => {
    for (const prefix of [
      `sessions/${SID}/`,
      `sessions/${SID}/photo-`,
      `pdfs/${SID}.pdf`,
      "comics/c1/pages/",
      "comics/c1/fonts/",
      "comics/some-id_2/pages/",
    ]) {
      expect(isDeletionListPrefix(prefix), prefix).toBe(true);
    }
  });
  it("refuses everything else", () => {
    for (const prefix of [
      "",
      "/",
      "sessions/",
      "sessions",
      "pdfs/",
      "comics/",
      "comics/videos/",
      "comics/lora/",
      "comics/c1/",
      "comics/c1/pages",
      "comics/c1/thumbnails/",
      "comics//pages/",
      "comics/a/b/pages/",
      `sessions/${SID}`,
      `sessions/${SID}/x`,
      `sessions/${SID}/photo`,
      `sessions/${SID.toUpperCase()}/`,
      `sessions/${SID}//`,
      `sessions/../${SID}/`,
      `sessions/${SID}/../`,
      `sessions/${SID}/\n`,
      `/sessions/${SID}/`,
      ` sessions/${SID}/`,
      `pdfs/${SID}.PDF`,
      `pdfs/${SID}.pdf/`,
      `pdfs/${SID}.pdf\n`,
      `pdfs/${SID}`,
      "sessions/not-a-uuid/",
      `other/sessions/${SID}/`,
    ]) {
      expect(isDeletionListPrefix(prefix), JSON.stringify(prefix)).toBe(false);
    }
  });
});

// FINDING: isDeletionKey refuses '..' but isDeletionListPrefix does not, and its comic folder pattern
// `[^/]+` matches '..'. Object keys are literal in S3/R2 (no path resolution), so this lists nothing
// outside the bucket, but the two guards disagree.
it("isDeletionListPrefix refuses a '..' comic folder, like isDeletionKey does", () => {
  expect(isDeletionListPrefix("comics/../pages/")).toBe(false);
});

describe("isDeletionKey", () => {
  it("accepts exactly the allowed keys", () => {
    for (const key of [
      `sessions/${SID}/photo-1.jpg`,
      `sessions/${SID}/pages/1/final.png`,
      `pdfs/${SID}.pdf`,
      "comics/c1/pages/p1.png",
      "comics/c1/pages/sub/p1.png",
      "comics/c1/fonts/f.ttf",
      "comics/videos/intro.mp4",
      "comics/lora/model.safetensors",
    ]) {
      expect(isDeletionKey(key), key).toBe(true);
    }
  });
  it("refuses the empty key, the bucket root and bare folders", () => {
    for (const key of [
      "",
      "/",
      "sessions/",
      "sessions",
      `sessions/${SID}/`,
      "comics/",
      "comics/c1/pages/",
      "comics/c1/fonts/",
      "comics/videos/",
      "comics/lora/",
      "pdfs/",
    ]) {
      expect(isDeletionKey(key), JSON.stringify(key)).toBe(false);
    }
  });
  it("refuses anything containing '..'", () => {
    for (const key of [
      `sessions/${SID}/../${OTHER}/a.png`,
      `sessions/${SID}/..`,
      "comics/c1/pages/../../x",
      "comics/videos/..",
      "comics/lora/a..b",
      `sessions/${SID}/a..png`,
    ]) {
      expect(isDeletionKey(key), key).toBe(false);
    }
  });
  it("refuses a session folder that is not a lower-case uuid", () => {
    for (const folder of [
      SID.toUpperCase(),
      "123",
      "not-a-uuid",
      "",
      `${SID}x`,
      SID.slice(1),
    ]) {
      expect(isDeletionKey(`sessions/${folder}/a.png`), folder).toBe(false);
    }
  });
  it("refuses another top-level folder, a missing trailing slash and nested videos or lora keys", () => {
    for (const key of [
      "other/a.png",
      `private/sessions/${SID}/a.png`,
      `sessions${SID}/a.png`,
      `/sessions/${SID}/a.png`,
      "comics/videos/a/b.mp4",
      "comics/lora/a/b.bin",
      "comics/c1/thumbnails/t.png",
      "comics/c1/pagesx/p.png",
      "comics/c1/pages",
      "comics//pages/p.png",
      `pdfs/${SID}.pdf/extra`,
      `pdfs/${SID}.pdf\n`,
      `pdfs/${SID.toUpperCase()}.pdf`,
      "pdfs/other.pdf",
      `pdfs/x/${SID}.pdf`,
      `sessions/${SID}/a\nb`,
    ]) {
      expect(isDeletionKey(key), JSON.stringify(key)).toBe(false);
    }
  });
  it("refuses user-controlled strings", () => {
    for (const key of [
      "../etc/passwd",
      "*",
      "%2e%2e/x",
      "sessions/*/a.png",
      "<script>",
      "null",
      "undefined",
      "[object Object]",
    ]) {
      expect(isDeletionKey(key), key).toBe(false);
    }
  });
});

describe("pdfKeyFor", () => {
  it("builds pdfs/<uuid>.pdf, which is itself an allowed key and list prefix", () => {
    expect(pdfKeyFor(SID)).toBe(`pdfs/${SID}.pdf`);
    expect(isDeletionKey(pdfKeyFor(SID))).toBe(true);
    expect(isDeletionListPrefix(pdfKeyFor(SID))).toBe(true);
  });
  it("throws for anything that is not a lower-case uuid", () => {
    for (const id of [
      "",
      "abc",
      SID.toUpperCase(),
      `${SID}/x`,
      `../${SID}`,
      `${SID}\n`,
      ` ${SID}`,
      `${SID}.pdf`,
    ]) {
      expect(() => pdfKeyFor(id), JSON.stringify(id)).toThrow(
        "pdfKeyFor needs a session id"
      );
    }
  });
});
