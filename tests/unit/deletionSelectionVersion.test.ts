import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SELECTION_VERSION } from "../../src/config/dataDeletion.js";

// Guards that a change to what a deletion group SELECTS forces a SELECTION_VERSION bump (feature 6). An approved
// report is only valid for the version it was made with, so a selection that changes silently would let an
// old approval authorise different deletions.
//
// How it works: for each group the text of the code that defines its selection (the where-clause builders, the
// pure decision functions and the constants they use, comments and whitespace removed) is hashed with sha256.
// APPROVED_HASHES holds, per group, the hash of each version. The map is append-only.
//
// To change a selection on purpose:
//   1. change the code and bump SELECTION_VERSION[group] in src/config/dataDeletion.ts (BOOKS too when
//      selectDelivered, deliveredDecision or the shared constants change, since PHOTOS and BOOKS share them);
//   2. run this test once: it fails for the new version and prints the new hash;
//   3. ADD a line `<new version>: "<hash>"` to the group below. Never edit or delete an older line.
// Editing only a comment or formatting does not change the hash. A change without a bump fails with
// "selection changed but SELECTION_VERSION did not".

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const stripComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A top-level function: from its `function` line to the line before the next top-level declaration. */
function functionText(source: string, name: string): string {
  const start = source.search(
    new RegExp(`^(export )?(async )?function ${name}\\b`, "m")
  );
  if (start < 0) throw new Error(`function ${name} not found`);
  const rest = source.slice(start);
  const afterFirstLine = rest.indexOf("\n") + 1;
  const next = rest
    .slice(afterFirstLine)
    .search(/^(export |async function |function |const |interface |type )/m);
  return next < 0 ? rest : rest.slice(0, afterFirstLine + next);
}

/** A top-level constant: from `const NAME` to the first `;` that ends a line. */
function constText(source: string, name: string): string {
  const match = source.match(
    new RegExp(`^(export )?const ${name}\\b[\\s\\S]*?;[ \\t]*$`, "m")
  );
  if (!match) throw new Error(`const ${name} not found`);
  return match[0];
}

const select = read("src/services/dataDeletionSelect.service.ts");
const config = read("src/config/dataDeletion.ts");
const orderAddress = read("src/config/orderAddress.ts");
const session = read("src/services/session.service.ts");

const fn = (name: string) => functionText(select, name);
const selectConst = (name: string) => constText(select, name);
const cfg = (...names: string[]) => names.map((n) => constText(config, n));

const TIME_BASE = cfg("HOUR_MS", "DAY_MS", "DELETION_MARGIN_MS");

const DEFINITIONS: Record<keyof typeof SELECTION_VERSION, string[]> = {
  PREVIEWS: [
    fn("selectPreviews"),
    fn("r1Decision"),
    selectConst("isLiveVersionStatus"),
    selectConst("R1_CREATED_ORDER_SESSION_STATUSES"),
    constText(session, "POST_PAYMENT_STATUSES"),
    constText(session, "EXPIRY_EXEMPT_STATUSES"),
    ...TIME_BASE,
    ...cfg(
      "PREVIEW_DELETION_DELAY_MS",
      "ORDER_SETTLE_MS",
      "PREVIEW_MAX_EXTRA_MS"
    ),
  ],
  PHOTOS: [
    fn("selectDelivered"),
    fn("deliveredDecision"),
    selectConst("isLiveVersionStatus"),
    ...TIME_BASE,
    ...cfg("PHOTO_DELETION_DAYS", "DELIVERED_FUTURE_TOLERANCE_MS"),
  ],
  BOOKS: [
    fn("selectDelivered"),
    fn("deliveredDecision"),
    fn("selectAddress"),
    selectConst("BOOK_DELETION_DAYS_MS"),
    selectConst("isLiveVersionStatus"),
    constText(orderAddress, "ADDRESS_SYNC_CLAIM_STALE_MS"),
    ...TIME_BASE,
    ...cfg("BOOK_DELETION_DAYS", "DELIVERED_FUTURE_TOLERANCE_MS"),
  ],
};

const hashOf = (parts: string[]) =>
  createHash("sha256")
    .update(parts.map(stripComments).join("\n"))
    .digest("hex");

/** Append-only: the hash of the selection of each version of each group. */
const APPROVED_HASHES: Record<
  keyof typeof SELECTION_VERSION,
  Record<number, string>
> = {
  PREVIEWS: {
    1: "9c716452615af85fba0dfe033ec59c78f75dfb5e064a946df430f8b3d0bb72fb",
  },
  PHOTOS: {
    1: "6f9d48e7d69f831303cc194be3efcbe43137744c1af0f9c47ba780e4283ce4cf",
  },
  BOOKS: {
    1: "8c6eef332feee68d74e1df065f5a33c072d49655adb6e8f3862cf29bad54fbae",
  },
};

describe("deletion selection version guard", () => {
  it("knows every group", () => {
    expect(Object.keys(DEFINITIONS).sort()).toEqual(
      Object.keys(SELECTION_VERSION).sort()
    );
    expect(Object.keys(APPROVED_HASHES).sort()).toEqual(
      Object.keys(SELECTION_VERSION).sort()
    );
  });

  it("extracts real code, not an empty or truncated text", () => {
    const text = (g: keyof typeof DEFINITIONS) =>
      DEFINITIONS[g].map(stripComments).join(" ");
    expect(text("PREVIEWS")).toContain("export function r1Decision");
    expect(text("PREVIEWS")).toContain('order: { status: "CREATED" }');
    expect(text("PREVIEWS")).toContain(
      "EXPIRY_EXEMPT_STATUSES: OrderSessionStatus[]"
    );
    expect(text("PREVIEWS")).toContain("PREVIEW_MAX_EXTRA_MS = 3 * DAY_MS");
    expect(text("PHOTOS")).toContain('status: "DELIVERED"');
    expect(text("PHOTOS")).toContain("PHOTO_DELETION_DAYS = 3");
    expect(text("BOOKS")).toContain("o.\"status\" = 'DELIVERED'");
    expect(text("BOOKS")).toContain("BOOK_DELETION_DAYS = 45");
    expect(text("BOOKS")).toContain("ADDRESS_SYNC_CLAIM_STALE_MS");
    for (const group of Object.keys(
      DEFINITIONS
    ) as (keyof typeof DEFINITIONS)[]) {
      expect(text(group).length, group).toBeGreaterThan(400);
    }
  });

  it("changing a comment or whitespace does not change the hash", () => {
    const a = hashOf(["function x() { return 1; } // note"]);
    const b = hashOf(["function   x() {\n  /* other */ return 1;\n}"]);
    expect(a).toBe(b);
    expect(hashOf(["function x() { return 2; }"])).not.toBe(a);
  });

  for (const group of Object.keys(
    SELECTION_VERSION
  ) as (keyof typeof SELECTION_VERSION)[]) {
    describe(group, () => {
      const version = SELECTION_VERSION[group];
      const approved = APPROVED_HASHES[group];

      it("keeps every earlier version in the map (append-only, no gaps)", () => {
        for (let v = 1; v <= version; v++) {
          expect(
            approved[v],
            `${group} version ${v} is missing from APPROVED_HASHES`
          ).toBeTruthy();
        }
        expect(
          Math.max(...Object.keys(approved).map(Number)),
          "SELECTION_VERSION went backwards"
        ).toBe(version);
      });

      it("has a hash for the current version that matches the code", () => {
        const actual = hashOf(DEFINITIONS[group]);
        const expected = approved[version];
        expect(
          actual,
          expected === undefined
            ? `no hash for ${group} version ${version}: add ${version}: "${actual}"`
            : `${group} selection changed but SELECTION_VERSION did not: bump SELECTION_VERSION.${group} to ${version + 1} and add ${version + 1}: "${actual}"`
        ).toBe(expected);
      });
    });
  }
});
