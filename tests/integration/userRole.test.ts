// Role changes against a real database (the Neon TEST branch only: the setup import below refuses any other).
// Only throwaway users made here are ever changed, so no real account is touched. The "last Master" refusal
// cannot be reached this way (other Master admins may exist in the test database); it is covered with a faked
// database in tests/unit/updateUserRole.test.ts.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { updateUserRole } from "../../src/services/user.service.js";

const RUN = Math.random().toString(36).slice(2, 8);
const id = (n: string) => `vitest-role-${RUN}-${n}`;
const IDS = ["actor", "m1", "m2", "m3", "m4", "u1", "u2"].map(id);

const roleOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).role;

beforeAll(async () => {
  await prisma.user.createMany({
    data: IDS.map((userId) => ({
      id: userId,
      name: "vitest role",
      email: `${userId}@example.test`,
      role: /-(actor|m\d)$/.test(userId) ? "ADMIN" : "USER",
    })),
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: IDS } } });
  await prisma.$disconnect();
});

describe("updateUserRole on a real database", () => {
  it("promotes a customer to sub-admin and back, and a Master to sub-admin", async () => {
    expect(
      (await updateUserRole(id("actor"), id("u1"), "SUB_ADMIN")).role
    ).toBe("SUB_ADMIN");
    expect(await roleOf(id("u1"))).toBe("SUB_ADMIN");
    expect((await updateUserRole(id("actor"), id("u1"), "USER")).role).toBe(
      "USER"
    );
    expect(
      (await updateUserRole(id("actor"), id("m1"), "SUB_ADMIN")).role
    ).toBe("SUB_ADMIN");
    expect(await roleOf(id("m1"))).toBe("SUB_ADMIN");
  });

  it("refuses a Master removing their own Master access", async () => {
    await expect(
      updateUserRole(id("actor"), id("actor"), "SUB_ADMIN")
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await roleOf(id("actor"))).toBe("ADMIN");
  });

  it("two Masters demoting the same Master at once: both succeed, the role is written once", async () => {
    const out = await Promise.all([
      updateUserRole(id("actor"), id("m2"), "SUB_ADMIN"),
      updateUserRole(id("m3"), id("m2"), "SUB_ADMIN"),
    ]);
    expect(out.map((u) => u.role)).toEqual(["SUB_ADMIN", "SUB_ADMIN"]);
    expect(await roleOf(id("m2"))).toBe("SUB_ADMIN");
  });

  it("two Masters making the same promotion at once: both succeed", async () => {
    const out = await Promise.all([
      updateUserRole(id("actor"), id("u2"), "SUB_ADMIN"),
      updateUserRole(id("m3"), id("u2"), "SUB_ADMIN"),
    ]);
    expect(out.map((u) => u.role)).toEqual(["SUB_ADMIN", "SUB_ADMIN"]);
  });

  it("a promotion and a demotion of the same user at once never leave a wrong or half-written role", async () => {
    // m4 is a Master: one request makes them a sub-admin, the other a customer. Whichever order the database
    // takes them in, the end state is one of the two, and a refusal is the "role changed" 409 only.
    const results = await Promise.allSettled([
      updateUserRole(id("actor"), id("m4"), "SUB_ADMIN"),
      updateUserRole(id("m3"), id("m4"), "USER"),
    ]);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ statusCode: 409 });
    }
    expect(["SUB_ADMIN", "USER"]).toContain(await roleOf(id("m4")));
  });

  it("answers 404 for a user that does not exist", async () => {
    await expect(
      updateUserRole(id("actor"), id("missing"), "SUB_ADMIN")
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
