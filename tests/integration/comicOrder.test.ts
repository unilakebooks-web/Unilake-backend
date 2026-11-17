// Integration tests for the admin's book order: the public list follows
// Comic.sortOrder (a bestseller badge does not move a book), the reorder rules
// (exactly the published set, drafts untouched, numbers reused and made strictly
// increasing), a new book goes to the top, and the migration's backfill keeps
// today's order. They run against the Neon TEST branch only: the setup import
// below refuses any other database.
import "../setup/env.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  createComic,
  getPublicComicsList,
  reorderComics,
} from "../../src/services/comic.service.js";
import {
  createComicSchema,
  reorderComicsSchema,
} from "../../src/validators/comic.schema.js";
import { ConflictError } from "../../src/utils/errors.js";

const MARK = "__vitest_comicorder__";
const RUN = Math.random().toString(36).slice(2, 8);
const TITLE = (label: string) => `${MARK} ${RUN} ${label}`;
const INDIA_ID = "00000000-0000-4000-8000-000000000010"; // seeded country

const ids: string[] = [];

async function make(
  label: string,
  opts: {
    sortOrder?: number;
    isBestseller?: boolean;
    status?: "PUBLISHED" | "DRAFT";
    createdAt?: string;
  } = {}
) {
  const comic = await prisma.comic.create({
    data: {
      title: TITLE(label),
      pageCount: 6,
      freePreviewPages: 2,
      status: opts.status ?? "PUBLISHED",
      isBestseller: opts.isBestseller ?? false,
      sortOrder: opts.sortOrder ?? 0,
      ...(opts.createdAt && { createdAt: new Date(opts.createdAt) }),
    },
  });
  ids.push(comic.id);
  return comic;
}

/** The public list as customers get it. */
const publicList = () =>
  getPublicComicsList({} as Parameters<typeof getPublicComicsList>[0]);

/** Ids of my comics, in the order the given list has them. */
const mine = (rows: { id: string }[]) =>
  rows.map((r) => r.id).filter((id) => ids.includes(id));

/** Every published id in a new order: the wanted ones last, in that order. */
async function fullOrder(wanted: string[]) {
  const all = (await publicList()).map((r) => r.id);
  return [...all.filter((id) => !wanted.includes(id)), ...wanted];
}

const sortOrderOf = async (id: string) =>
  (await prisma.comic.findUniqueOrThrow({ where: { id } })).sortOrder;

beforeAll(async () => {
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
});

afterAll(async () => {
  await prisma.pricingRule.deleteMany({ where: { comicId: { in: ids } } });
  await prisma.comic.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("the public list follows the admin's order", () => {
  it("orders by sortOrder, and a bestseller badge does not move a book", async () => {
    const a = await make("A bestseller", { sortOrder: 5, isBestseller: true });
    const b = await make("B", { sortOrder: 3 });
    const c = await make("C", { sortOrder: 4 });
    expect(mine(await publicList())).toEqual([b.id, c.id, a.id]);
  });

  it("books with the same number fall back to newest first, then id", async () => {
    const older = await make("older", {
      sortOrder: 9,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const newer = await make("newer", {
      sortOrder: 9,
      createdAt: "2026-02-01T00:00:00Z",
    });
    const rows = mine(await publicList());
    expect(rows.indexOf(newer.id)).toBeLessThan(rows.indexOf(older.id));
  });

  it("does not return the sortOrder to customers", async () => {
    const rows = await publicList();
    expect(JSON.stringify(rows)).not.toContain("sortOrder");
  });
});

describe("reordering", () => {
  it("applies the new order to the public list and returns the saved numbers", async () => {
    const f = await make("F", { sortOrder: 0 });
    const g = await make("G", { sortOrder: 0 });
    const h = await make("H", { sortOrder: 0 });
    const result = await reorderComics(await fullOrder([h.id, f.id, g.id]));
    expect(mine(await publicList())).toEqual(
      expect.arrayContaining([h.id, f.id, g.id])
    );
    const order = mine(await publicList());
    expect(order.indexOf(h.id)).toBeLessThan(order.indexOf(f.id));
    expect(order.indexOf(f.id)).toBeLessThan(order.indexOf(g.id));
    expect(result.find((r) => r.id === h.id)).toBeDefined();
  });

  it("makes the numbers strictly increasing, so a drag is never tied away", async () => {
    // Three never-arranged books all at 0, then a save: every published book
    // must hold a different number, ascending in the saved order.
    const x = await make("tie-x", { sortOrder: 0 });
    const y = await make("tie-y", { sortOrder: 0 });
    const z = await make("tie-z", { sortOrder: 0 });
    await reorderComics(await fullOrder([z.id, x.id, y.id]));
    const published = await prisma.comic.findMany({
      where: { status: "PUBLISHED" },
      select: { id: true, sortOrder: true },
    });
    const numbers = published.map((c) => c.sortOrder);
    expect(new Set(numbers).size).toBe(numbers.length);
    const order = mine(await publicList());
    expect(order.indexOf(z.id)).toBeLessThan(order.indexOf(x.id));
    expect(order.indexOf(x.id)).toBeLessThan(order.indexOf(y.id));
  });

  it("reuses the numbers the set already held, in order", async () => {
    // Make the numbers strictly increasing first, so this does not depend on what
    // earlier tests left behind.
    await reorderComics((await publicList()).map((r) => r.id));
    const before = (
      await prisma.comic.findMany({
        where: { status: "PUBLISHED" },
        select: { sortOrder: true },
      })
    )
      .map((c) => c.sortOrder)
      .sort((x, y) => x - y);
    const current = await publicList();
    await reorderComics([...current].reverse().map((r) => r.id));
    const after = (
      await prisma.comic.findMany({
        where: { status: "PUBLISHED" },
        select: { sortOrder: true },
      })
    )
      .map((c) => c.sortOrder)
      .sort((x, y) => x - y);
    expect(after).toEqual(before); // already strictly increasing: same numbers
    expect((await publicList()).map((r) => r.id)).toEqual(
      current.map((r) => r.id).reverse()
    );
  });

  it("does not touch a draft, and a draft in the list is refused", async () => {
    const draft = await make("draft", { status: "DRAFT", sortOrder: 7 });
    const everyone = (await publicList()).map((r) => r.id);
    await reorderComics(everyone);
    expect(await sortOrderOf(draft.id)).toBe(7);
    await expect(reorderComics([...everyone, draft.id])).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(await sortOrderOf(draft.id)).toBe(7);
  });

  it("refuses a list that misses a published book, or has an unknown id, and writes nothing", async () => {
    const everyone = (await publicList()).map((r) => r.id);
    const before = everyone.slice();
    await expect(reorderComics(everyone.slice(1))).rejects.toBeInstanceOf(
      ConflictError
    );
    await expect(
      reorderComics([
        ...everyone.slice(1),
        "00000000-0000-4000-8000-00000000dead",
      ])
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await publicList()).map((r) => r.id)).toEqual(before);
  });

  it("a filtered public list keeps the admin's order (a bestseller badge does not float up)", async () => {
    const first = await make("filter-first", { sortOrder: 60 });
    const last = await make("filter-last", {
      sortOrder: 61,
      isBestseller: true,
    });
    const rows = await getPublicComicsList({
      search: `${MARK} ${RUN} filter-`,
    } as Parameters<typeof getPublicComicsList>[0]);
    expect(rows.map((r) => r.id)).toEqual([first.id, last.id]);
  });

  it("two saves at the same moment both finish, and the result is one of the two orders", async () => {
    const ordered = (await publicList()).map((r) => r.id);
    const reversed = [...ordered].reverse();
    const results = await Promise.allSettled([
      reorderComics(ordered),
      reorderComics(reversed),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const after = (await publicList()).map((r) => r.id);
    expect([ordered.join(), reversed.join()]).toContain(after.join());
    const numbers = (
      await prisma.comic.findMany({
        where: { status: "PUBLISHED" },
        select: { sortOrder: true },
      })
    ).map((c) => c.sortOrder);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("a book unpublished between the check and the write is left alone and the save still finishes", async () => {
    const p = await make("race-p", { sortOrder: 70 });
    const q = await make("race-q", { sortOrder: 71 });
    const r = await make("race-r", { sortOrder: 72 });
    const everyone = (await publicList()).map((row) => row.id);
    // q goes to the very front, so if it were written it would get the smallest
    // number in the set, never its own 71.
    const wanted = [q.id, ...everyone.filter((id) => id !== q.id)];
    // A real race, not a stub: a transaction locks q's row, the reorder passes
    // its check (reads do not wait) and then waits at q's write; q is then
    // unpublished and the lock released, so the write meets a row that is no
    // longer PUBLISHED. If the wait were too short the check itself would see
    // the unpublish and answer 409, which fails this test loudly.
    let saving: ReturnType<typeof reorderComics> | undefined;
    await prisma.$transaction(
      async (tx) => {
        await tx.comic.update({
          where: { id: q.id },
          data: { status: "UNPUBLISHED" },
        });
        saving = reorderComics(wanted);
        saving.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      },
      { timeout: 30000, maxWait: 30000 }
    );
    await saving;
    expect(await sortOrderOf(q.id)).toBe(71); // never written: no longer published
    const order = mine(await publicList());
    expect(order).not.toContain(q.id);
    expect(order.indexOf(p.id)).toBeLessThan(order.indexOf(r.id)); // the rest keep their order
  });

  it("saves a long list in one go and applies it", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      title: TITLE(`bulk-${i}`),
      pageCount: 6,
      freePreviewPages: 2,
      status: "PUBLISHED" as const,
      sortOrder: 1000 + i,
    }));
    await prisma.comic.createMany({ data: rows });
    const created = await prisma.comic.findMany({
      where: { title: { startsWith: TITLE("bulk-") } },
      select: { id: true },
    });
    ids.push(...created.map((c) => c.id));
    const everyone = (await publicList()).map((r) => r.id);
    const bulk = new Set(created.map((c) => c.id));
    const reversed = [
      ...everyone.filter((id) => !bulk.has(id)),
      ...everyone.filter((id) => bulk.has(id)).reverse(),
    ];
    const started = Date.now();
    await reorderComics(reversed);
    const seconds = (Date.now() - started) / 1000;
    expect((await publicList()).map((r) => r.id)).toEqual(reversed);
    expect(seconds).toBeLessThan(3); // one statement; 200 separate updates take several seconds
  });

  it("many pairs of opposite saves over a long list all finish (no deadlock)", async () => {
    const ordered = (await publicList()).map((r) => r.id);
    const reversed = [...ordered].reverse();
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled([
        reorderComics(ordered),
        reorderComics(reversed),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    }
  });

  it("a book still publishing is not part of the set, and a republished book is", async () => {
    const book = await make("publishing", { status: "PUBLISHING" as never });
    const everyone = (await publicList()).map((r) => r.id);
    expect(everyone).not.toContain(book.id);
    await expect(reorderComics([...everyone, book.id])).rejects.toBeInstanceOf(
      ConflictError
    );
    await prisma.comic.update({
      where: { id: book.id },
      data: { status: "PUBLISHED" },
    });
    await expect(reorderComics(everyone)).rejects.toBeInstanceOf(ConflictError);
    await reorderComics((await publicList()).map((r) => r.id));
    expect((await publicList()).map((r) => r.id)).toContain(book.id);
  });

  it("saving the order that is already saved changes nothing", async () => {
    const before = (await publicList()).map((r) => r.id);
    await reorderComics(before);
    await reorderComics(before);
    expect((await publicList()).map((r) => r.id)).toEqual(before);
  });

  it("books with the same number and the same creation time fall back to id", async () => {
    const a = await make("same-a", {
      sortOrder: 50,
      createdAt: "2026-05-01T00:00:00Z",
    });
    const b = await make("same-b", {
      sortOrder: 50,
      createdAt: "2026-05-01T00:00:00Z",
    });
    const [first, second] = [a.id, b.id].sort();
    const rows = mine(await publicList());
    expect(rows.indexOf(first!)).toBeLessThan(rows.indexOf(second!));
  });

  it("the request schema rejects empty, duplicate and non-uuid lists", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(reorderComicsSchema.safeParse({ orderedIds: [] }).success).toBe(
      false
    );
    expect(
      reorderComicsSchema.safeParse({ orderedIds: [id, id] }).success
    ).toBe(false);
    expect(
      reorderComicsSchema.safeParse({ orderedIds: ["nope"] }).success
    ).toBe(false);
    expect(reorderComicsSchema.safeParse({ orderedIds: [id] }).success).toBe(
      true
    );
  });
});

describe("a new book goes to the top", () => {
  it("takes a number smaller than every other book's", async () => {
    const theme = await prisma.theme.findFirstOrThrow();
    const created = await createComic(
      createComicSchema.parse({
        title: TITLE("created through the service"),
        genderTags: ["UNISEX"],
        pageCount: 6,
        freePreviewPages: 2,
        thumbnailKeys: ["comics/__vitest__/thumb.png"],
        pricing: [
          { countryId: INDIA_ID, coverType: "HARDCOVER", mrp: 999, price: 799 },
        ],
        themeIds: [theme.id],
        ageGroups: ["AGE_3_5"],
      })
    );
    ids.push(created.id);
    const others = await prisma.comic.findMany({
      where: { id: { not: created.id } },
      select: { sortOrder: true },
    });
    expect(created.status).toBe("DRAFT");
    expect(created.sortOrder).toBeLessThan(
      Math.min(...others.map((o) => o.sortOrder))
    );
  });
});

// LAST on purpose: the backfill statement renumbers every comic in the test
// database, so no other test may run after it.
describe("the migration's backfill keeps today's order", () => {
  // The real UPDATE statement from the migration file, not a copy of it.
  function backfillSql() {
    const dir = readdirSync(join(process.cwd(), "prisma/migrations")).find(
      (d) => d.endsWith("_add_comic_sort_order")
    );
    if (!dir) throw new Error("migration directory not found");
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations", dir, "migration.sql"),
      "utf8"
    );
    const start = sql.indexOf('UPDATE "comics"');
    if (start < 0) throw new Error("backfill statement not found");
    return sql.slice(start);
  }

  it("numbers bestsellers first, then newest first, every status, ties by id", async () => {
    // Every row starts at 100: a row the statement skipped would stay at 100
    // and sort last. Six non-bestsellers share one creation time, so a missing
    // id tie-break would almost surely give a different order.
    const row = (label: string, iso: string, extra: object = {}) =>
      make(label, { sortOrder: 100, createdAt: iso, ...extra });
    const oldBest = await row("old bestseller", "2026-01-01T00:00:00Z", {
      isBestseller: true,
    });
    const newBest = await row("new bestseller", "2026-02-01T00:00:00Z", {
      isBestseller: true,
    });
    const draftMid = await row("draft middle", "2026-03-15T00:00:00Z", {
      status: "DRAFT",
    });
    const ties = [];
    for (let i = 0; i < 6; i++)
      ties.push(await row(`tie-${i}`, "2026-03-01T00:00:00Z"));
    const newest = await row("newest", "2026-04-01T00:00:00Z");
    const added = [oldBest, newBest, draftMid, ...ties, newest];

    await prisma.$executeRawUnsafe(backfillSql());

    const rows = await prisma.comic.findMany({
      where: { id: { in: added.map((c) => c.id) } },
      orderBy: { sortOrder: "asc" },
    });
    const tieIds = ties.map((c) => c.id).sort();
    expect(rows.map((r) => r.id)).toEqual([
      newBest.id,
      oldBest.id,
      newest.id,
      draftMid.id,
      ...tieIds,
    ]);

    await prisma.$executeRawUnsafe(backfillSql()); // same input, same numbers
    const again = await prisma.comic.findMany({
      where: { id: { in: added.map((c) => c.id) } },
      orderBy: { sortOrder: "asc" },
    });
    expect(again.map((r) => [r.id, r.sortOrder])).toEqual(
      rows.map((r) => [r.id, r.sortOrder])
    );
  });

  it("leaves updatedAt alone", async () => {
    const c = await make("stamp");
    await prisma.$executeRawUnsafe(
      `UPDATE "comics" SET "updatedAt" = '2026-01-02T00:00:00Z' WHERE "id" = '${c.id}'`
    );
    await prisma.$executeRawUnsafe(backfillSql());
    const after = await prisma.comic.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.updatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});
