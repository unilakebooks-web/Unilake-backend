import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config/env.js", () => ({
  config: { r2: { publicUrlBase: "https://media.example.test/" } },
}));

import {
  IGNORED_URL_COLUMNS,
  SCANNED_URL_COLUMNS,
} from "../../src/utils/deletionKeys.js";

// Plan section 4: a retired comic's file is kept when any other row names it, so every column of schema.prisma that
// holds a URL or an object key is either scanned (SCANNED_URL_COLUMNS) or ignored with a reason
// (IGNORED_URL_COLUMNS). A new such column fails this test until someone classifies it.

const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8"
);

/** "Model.column" of every String or String[] column whose name looks like a URL, a key, a path or a file. */
function urlLikeColumns(): string[] {
  const found: string[] = [];
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const line of match[2]!.split("\n")) {
      const field = line.match(/^\s+(\w+)\s+String(\[\])?\??(\s|$)/);
      if (!field) continue;
      const name = field[1]!;
      if (
        /url|key|image|video|poster|path|file|photo|thumb|pdf|mask/i.test(name)
      )
        found.push(`${match[1]}.${name}`);
    }
  }
  return found;
}

describe("the reference scan covers every URL and key column of the schema", () => {
  const columns = urlLikeColumns();

  it("finds the columns it is meant to find", () => {
    expect(columns).toContain("Page.artworkUrl");
    expect(columns).toContain("HeroImage.imageUrl");
    expect(columns).toContain("Font.fileUrl");
  });

  it("every URL-like column is scanned or ignored with a reason", () => {
    const known = new Set([
      ...SCANNED_URL_COLUMNS,
      ...Object.keys(IGNORED_URL_COLUMNS),
    ]);
    expect(columns.filter((column) => !known.has(column))).toEqual([]);
  });

  it("no column is both scanned and ignored, and every listed column still exists", () => {
    for (const column of SCANNED_URL_COLUMNS)
      expect(IGNORED_URL_COLUMNS[column], column).toBeUndefined();
    const all = new Set(columns);
    for (const column of [
      ...SCANNED_URL_COLUMNS,
      ...Object.keys(IGNORED_URL_COLUMNS),
    ])
      expect(all.has(column), `${column} is not in the schema`).toBe(true);
  });

  it("every ignored column has a reason", () => {
    for (const reason of Object.values(IGNORED_URL_COLUMNS))
      expect(reason.length).toBeGreaterThan(5);
  });
});
