import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    user: { count: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  };
  return {
    tx,
    userCount: vi.fn(),
    userFindMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    // Both forms of $transaction the service uses: a callback (with the transaction) and a list of queries.
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (t: typeof tx) => unknown)(tx)
    ),
  };
});
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: db.findUnique,
      findMany: db.userFindMany,
      count: db.userCount,
      updateMany: db.updateMany,
    },
    $transaction: db.$transaction,
  },
}));
const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: log.info, error: vi.fn(), warn: vi.fn() },
}));

import {
  listAdminUsers,
  updateUserRole,
} from "../../src/services/user.service.js";

const row = (role: string) => ({
  id: "target",
  name: "T",
  email: "t@x",
  image: null,
  role,
  createdAt: new Date(),
});

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { statusCode: number; message: string };
  }
  return undefined;
}

beforeEach(() => {
  db.findUnique.mockReset();
  db.updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.$transaction.mockClear();
  log.info.mockClear();
  db.tx.$executeRaw.mockReset();
  db.tx.user.count.mockReset();
  db.tx.user.update.mockReset();
  db.tx.user.findUnique.mockReset().mockResolvedValue(row("ADMIN"));
  db.userCount.mockReset();
  db.userFindMany.mockReset();
});

describe("updateUserRole", () => {
  it("answers 404 for a user that does not exist", async () => {
    db.findUnique.mockResolvedValue(null);
    expect(
      (await failure(updateUserRole("actor", "target", "ADMIN")))?.statusCode
    ).toBe(404);
  });

  it("returns the user unchanged, and writes nothing, when the role is already that role", async () => {
    db.findUnique.mockResolvedValue(row("SUB_ADMIN"));
    const out = await updateUserRole("actor", "target", "SUB_ADMIN");
    expect(out.role).toBe("SUB_ADMIN");
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(["USER", "SUB_ADMIN"] as const)(
    "refuses a Master removing their own Master access (to %s)",
    async (to) => {
      db.findUnique.mockResolvedValue(row("ADMIN"));
      const e = await failure(updateUserRole("target", "target", to));
      expect(e?.statusCode).toBe(409);
      expect(e?.message).toMatch(/own Master admin access/);
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(["USER", "SUB_ADMIN"] as const)(
    "refuses to demote the only Master admin (to %s), after taking the lock",
    async (to) => {
      db.findUnique.mockResolvedValue(row("ADMIN"));
      db.tx.user.count.mockResolvedValue(1);
      const e = await failure(updateUserRole("other", "target", to));
      expect(e?.statusCode).toBe(409);
      expect(e?.message).toMatch(/at least one Master admin/);
      expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
      // Only Master admins are counted (a sub-admin must never count as the "other" Master), after the lock.
      expect(db.tx.user.count).toHaveBeenCalledWith({
        where: { role: "ADMIN" },
      });
      expect(db.tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        db.tx.user.count.mock.invocationCallOrder[0]!
      );
      expect(db.tx.user.update).not.toHaveBeenCalled();
    }
  );

  it.each(["USER", "SUB_ADMIN"] as const)(
    "demotes a Master to %s when another Master remains, under the lock",
    async (to) => {
      db.findUnique.mockResolvedValue(row("ADMIN"));
      db.tx.user.count.mockResolvedValue(2);
      db.tx.user.update.mockResolvedValue(row(to));
      const out = await updateUserRole("other", "target", to);
      expect(out.role).toBe(to);
      expect(db.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "target" }, data: { role: to } })
      );
      expect(db.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["USER", "SUB_ADMIN"],
    ["SUB_ADMIN", "USER"],
    ["SUB_ADMIN", "ADMIN"],
    ["USER", "ADMIN"],
  ] as const)(
    "%s to %s takes no lock and writes only if the role is still the one that was read",
    async (from, to) => {
      // The first read, then the read-back after the write.
      db.findUnique
        .mockResolvedValueOnce(row(from))
        .mockResolvedValueOnce(row(to));
      const out = await updateUserRole("actor", "target", to);
      expect(out.role).toBe(to);
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: "target", role: from },
        data: { role: to },
      });
    }
  );

  it("a role that changed between the read and the write is refused (409), not overwritten, and not logged as a change", async () => {
    // Read as SUB_ADMIN; meanwhile another request promoted the user to ADMIN, so the guarded write matches nothing.
    db.findUnique
      .mockResolvedValueOnce(row("SUB_ADMIN"))
      .mockResolvedValueOnce(row("ADMIN"));
    db.updateMany.mockResolvedValue({ count: 0 });
    const e = await failure(updateUserRole("actor", "target", "USER"));
    expect(e?.statusCode).toBe(409);
    expect(e?.message).toMatch(/role changed while you were saving/);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("two Master admins making the same change at once: the second is a success, and only the first is logged", async () => {
    db.findUnique
      .mockResolvedValueOnce(row("USER"))
      .mockResolvedValueOnce(row("SUB_ADMIN"));
    db.updateMany.mockResolvedValue({ count: 0 });
    const out = await updateUserRole("actor", "target", "SUB_ADMIN");
    expect(out.role).toBe("SUB_ADMIN");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("a write that matched is a success even if another change landed before the read-back", async () => {
    db.findUnique
      .mockResolvedValueOnce(row("USER"))
      .mockResolvedValueOnce(row("ADMIN"));
    db.updateMany.mockResolvedValue({ count: 1 });
    const out = await updateUserRole("actor", "target", "SUB_ADMIN");
    expect(out.role).toBe("ADMIN");
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("a user deleted between the read and the write is a 404, not a 500", async () => {
    db.findUnique
      .mockResolvedValueOnce(row("USER"))
      .mockResolvedValueOnce(null);
    db.updateMany.mockResolvedValue({ count: 0 });
    expect(
      (await failure(updateUserRole("actor", "target", "SUB_ADMIN")))
        ?.statusCode
    ).toBe(404);
  });

  it("a Master demotion whose target stopped being a Master before the lock is refused, and nothing is counted or written", async () => {
    db.findUnique.mockResolvedValue(row("ADMIN"));
    db.tx.user.findUnique.mockResolvedValue(row("USER"));
    const e = await failure(updateUserRole("other", "target", "SUB_ADMIN"));
    expect(e?.statusCode).toBe(409);
    expect(e?.message).toMatch(/role changed while you were saving/);
    expect(db.tx.user.count).not.toHaveBeenCalled();
    expect(db.tx.user.update).not.toHaveBeenCalled();
    // The in-lock read is of the target, taken after the lock.
    expect(db.tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "target" } })
    );
    expect(db.tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      db.tx.user.findUnique.mock.invocationCallOrder[0]!
    );
  });
});

describe("updateUserRole: a demotion that races another change", () => {
  it("two Master admins demoting the same Master to the same role at once: the second is a success, nothing is counted, written or logged", async () => {
    db.findUnique.mockResolvedValue(row("ADMIN"));
    db.tx.user.findUnique.mockResolvedValue(row("SUB_ADMIN")); // the first request already did it
    const out = await updateUserRole("other", "target", "SUB_ADMIN");
    expect(out.role).toBe("SUB_ADMIN");
    expect(db.tx.user.count).not.toHaveBeenCalled();
    expect(db.tx.user.update).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("a Master deleted before the lock is a 404", async () => {
    db.findUnique.mockResolvedValue(row("ADMIN"));
    db.tx.user.findUnique.mockResolvedValue(null);
    expect(
      (await failure(updateUserRole("other", "target", "USER")))?.statusCode
    ).toBe(404);
    expect(db.tx.user.count).not.toHaveBeenCalled();
  });

  it("a real demotion is logged once", async () => {
    db.findUnique.mockResolvedValue(row("ADMIN"));
    db.tx.user.count.mockResolvedValue(2);
    db.tx.user.update.mockResolvedValue(row("USER"));
    await updateUserRole("other", "target", "USER");
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe("listAdminUsers: the header's admin count", () => {
  it("counts Master admins only (a sub-admin is not an admin for the last-Master rule or the header)", async () => {
    db.userFindMany.mockResolvedValue([]);
    db.userCount.mockResolvedValue(3);
    const out = await listAdminUsers({ page: 1, pageSize: 20 } as never);
    expect(out.adminCount).toBe(3);
    expect(db.userCount).toHaveBeenCalledWith({ where: { role: "ADMIN" } });
  });
});
