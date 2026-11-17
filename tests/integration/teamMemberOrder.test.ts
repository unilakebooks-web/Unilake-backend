// Integration tests for the admin's team member order: the backfill that keeps
// today's order, where a new member appears, the reorder (complete list, hidden
// members keep a slot), and that the public and admin lists follow the order.
// They run against the Neon TEST branch only: the setup import refuses any
// other database.
import "../setup/env.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  createTeamMember,
  getActiveTeamMembers,
  getAllTeamMembers,
  reorderTeamMembers,
  toggleTeamMemberStatus,
} from "../../src/services/teamMember.service.js";
import { reorderTeamMembersSchema } from "../../src/validators/teamMember.schema.js";
import { ConflictError } from "../../src/utils/errors.js";

const MARK = "__vitest_teamorder__";
const RUN = Math.random().toString(36).slice(2, 8);
const NAME = (label: string) => `${MARK} ${RUN} ${label}`;

const ids: string[] = [];
async function make(label: string) {
  const m = await createTeamMember({ name: NAME(label), role: "Tester" });
  ids.push(m.id);
  return m;
}

/** Ids of the given members, in the order a list returns them. */
const mine = (rows: { id: string }[]) =>
  rows.map((r) => r.id).filter((id) => ids.includes(id));

/** Every member's id in a new order: mine in `wanted` order, others untouched. */
async function fullOrder(wanted: string[]) {
  const all = await getAllTeamMembers();
  const others = all.map((r) => r.id).filter((id) => !ids.includes(id));
  return [...others, ...wanted];
}

beforeAll(async () => {
  await prisma.teamMember.deleteMany({
    where: { name: { startsWith: MARK } },
  });
});

afterAll(async () => {
  await prisma.teamMember.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("a new member goes to the end", () => {
  it("takes the next sortOrder and appears in creation order among themselves", async () => {
    const a = await make("A");
    const b = await make("B");
    const c = await make("C");
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(c.sortOrder).toBeGreaterThan(b.sortOrder);
    expect(mine(await getAllTeamMembers())).toEqual([a.id, b.id, c.id]);
    expect(mine(await getActiveTeamMembers())).toEqual([a.id, b.id, c.id]);
  });
});

describe("reordering", () => {
  it("applies the new order to the admin and the public list", async () => {
    const [a, b, c] = ids.slice(0, 3) as [string, string, string];
    const result = await reorderTeamMembers(await fullOrder([c, a, b]));
    expect(mine(result)).toEqual([c, a, b]);
    expect(mine(await getAllTeamMembers())).toEqual([c, a, b]);
    expect(mine(await getActiveTeamMembers())).toEqual([c, a, b]);
  });

  it("numbers the members 0..N-1 in the saved order", async () => {
    const rows = await getAllTeamMembers();
    expect(rows.map((r) => r.sortOrder)).toEqual(rows.map((_, i) => i));
  });

  it("a hidden member keeps its slot and is only hidden from the public list", async () => {
    const [a, b, c] = ids.slice(0, 3) as [string, string, string];
    await toggleTeamMemberStatus(a); // hide A (second in the order)
    expect(mine(await getAllTeamMembers())).toEqual([c, a, b]);
    expect(mine(await getActiveTeamMembers())).toEqual([c, b]);
    await toggleTeamMemberStatus(a); // show it again
    expect(mine(await getActiveTeamMembers())).toEqual([c, a, b]);
  });

  it("a member created after a reorder still goes to the end", async () => {
    const d = await make("D");
    const all = await getAllTeamMembers();
    expect(all[all.length - 1]?.id).toBe(d.id);
  });

  it("refuses a list that misses a member, and leaves the order alone", async () => {
    const before = mine(await getAllTeamMembers());
    const everyone = (await getAllTeamMembers()).map((r) => r.id);
    await expect(reorderTeamMembers(everyone.slice(1))).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(mine(await getAllTeamMembers())).toEqual(before);
  });

  it("refuses a list with an id that does not exist", async () => {
    const everyone = (await getAllTeamMembers()).map((r) => r.id);
    const withGhost = [
      ...everyone.slice(1),
      "00000000-0000-4000-8000-00000000dead",
    ];
    const before = mine(await getAllTeamMembers());
    await expect(reorderTeamMembers(withGhost)).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(mine(await getAllTeamMembers())).toEqual(before);
  });

  it("answers 409 (not a server error) when a member is deleted during the save", async () => {
    const everyone = (await getAllTeamMembers()).map((r) => r.id);
    const before = mine(await getAllTeamMembers());
    // The checks pass, then the write finds a row gone (Prisma P2025).
    // One failing call; any later call goes through to the real function.
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      Object.assign(new Error("gone"), { code: "P2025" })
    );
    await expect(reorderTeamMembers(everyone)).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(mine(await getAllTeamMembers())).toEqual(before);
  });

  it("the request schema rejects empty, duplicate and non-uuid lists", () => {
    expect(reorderTeamMembersSchema.safeParse({ orderedIds: [] }).success).toBe(
      false
    );
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      reorderTeamMembersSchema.safeParse({ orderedIds: [id, id] }).success
    ).toBe(false);
    expect(
      reorderTeamMembersSchema.safeParse({ orderedIds: ["nope"] }).success
    ).toBe(false);
    expect(
      reorderTeamMembersSchema.safeParse({ orderedIds: [id] }).success
    ).toBe(true);
  });

  it("changes only the order and the updated time of a member", async () => {
    const [a] = ids as [string];
    const before = await prisma.teamMember.findUniqueOrThrow({
      where: { id: a },
    });
    await reorderTeamMembers(await fullOrder([...ids]));
    const after = await prisma.teamMember.findUniqueOrThrow({
      where: { id: a },
    });
    expect({ ...after, sortOrder: 0, updatedAt: 0 }).toEqual({
      ...before,
      sortOrder: 0,
      updatedAt: 0,
    });
  });
});

describe("the migration's backfill keeps today's order", () => {
  // The real UPDATE statement from the migration file, not a copy of it.
  function backfillSql() {
    const dir = readdirSync(join(process.cwd(), "prisma/migrations")).find(
      (d) => d.endsWith("_add_team_member_sort_order")
    );
    if (!dir) throw new Error("migration directory not found");
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations", dir, "migration.sql"),
      "utf8"
    );
    const start = sql.indexOf('UPDATE "team_members"');
    if (start < 0) throw new Error("backfill statement not found");
    return sql.slice(start);
  }

  it("numbers members newest first, hidden ones included, ties by id", async () => {
    const created = (label: string, iso: string, isActive = true) =>
      prisma.teamMember.create({
        data: {
          name: NAME(label),
          role: "Old",
          isActive,
          createdAt: new Date(iso),
          sortOrder: 0,
        },
      });
    const oldest = await created("oldest", "2026-01-01T00:00:00Z");
    const middle = await created("middle", "2026-02-01T00:00:00Z");
    const hidden = await created(
      "newest hidden",
      "2026-04-01T00:00:00Z",
      false
    );
    const tieX = await created("tie-x", "2026-03-01T00:00:00Z");
    const tieY = await created("tie-y", "2026-03-01T00:00:00Z");
    const added = [oldest, middle, hidden, tieX, tieY];
    ids.push(...added.map((m) => m.id));

    await prisma.teamMember.updateMany({
      where: { id: { in: added.map((m) => m.id) } },
      data: { sortOrder: 0 },
    });
    await prisma.$executeRawUnsafe(backfillSql());

    const rows = await prisma.teamMember.findMany({
      where: { id: { in: added.map((m) => m.id) } },
      orderBy: { sortOrder: "asc" },
    });
    const tie = [tieX.id, tieY.id].sort(); // exact ties: ascending id
    expect(rows.map((r) => r.id)).toEqual([
      hidden.id,
      tie[0],
      tie[1],
      middle.id,
      oldest.id,
    ]);

    // Running it again changes nothing (same input, same numbers).
    await prisma.$executeRawUnsafe(backfillSql());
    const again = await prisma.teamMember.findMany({
      where: { id: { in: added.map((m) => m.id) } },
      orderBy: { sortOrder: "asc" },
    });
    expect(again.map((r) => [r.id, r.sortOrder])).toEqual(
      rows.map((r) => [r.id, r.sortOrder])
    );
  });

  it("leaves updatedAt alone", async () => {
    const m = await prisma.teamMember.create({
      data: {
        name: NAME("stamp"),
        role: "T",
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
    ids.push(m.id);
    await prisma.$executeRawUnsafe(backfillSql());
    const after = await prisma.teamMember.findUniqueOrThrow({
      where: { id: m.id },
    });
    expect(after.updatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});
