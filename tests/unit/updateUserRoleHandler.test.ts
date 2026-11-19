import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ updateUserRole: vi.fn() }));
vi.mock("../../src/services/user.service.js", () => ({
  listAdminUsers: vi.fn(),
  updateUserRole: holder.updateUserRole,
}));

import { updateUserRoleHandler } from "../../src/controllers/user.controller.js";
import {
  UserRoleEnum,
  updateUserRoleSchema,
} from "../../src/validators/user.schema.js";

function call(actor: { id: string; role?: unknown } | undefined, role: string) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  const req = { user: actor, params: { userId: "target-1" }, body: { role } };
  updateUserRoleHandler(req as never, { status } as never, next);
  return { status, json, next };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  holder.updateUserRole.mockReset().mockResolvedValue({ id: "target-1" });
});

describe("PATCH /users/:userId/role: second check by the handler itself", () => {
  it.each(["SUB_ADMIN", "USER", undefined, null, "admin", ""])(
    "refuses an actor whose role is %s and changes nothing",
    async (role) => {
      const c = call({ id: "actor-1", role }, "ADMIN");
      await settle();
      expect(c.next).toHaveBeenCalledTimes(1);
      expect(
        (c.next.mock.calls[0]?.[0] as { statusCode: number }).statusCode
      ).toBe(403);
      expect(holder.updateUserRole).not.toHaveBeenCalled();
    }
  );

  it("refuses when there is no user on the request", async () => {
    const c = call(undefined, "ADMIN");
    await settle();
    expect(
      (c.next.mock.calls[0]?.[0] as { statusCode: number }).statusCode
    ).toBe(403);
    expect(holder.updateUserRole).not.toHaveBeenCalled();
  });

  it("lets a Master admin change a role, and takes the actor from the session", async () => {
    const c = call({ id: "actor-1", role: "ADMIN" }, "SUB_ADMIN");
    await settle();
    expect(c.next).not.toHaveBeenCalled();
    expect(holder.updateUserRole).toHaveBeenCalledWith(
      "actor-1",
      "target-1",
      "SUB_ADMIN"
    );
    expect(c.status).toHaveBeenCalledWith(200);
  });
});

describe("role values", () => {
  it("accept the three roles, uppercase only", () => {
    for (const r of ["ADMIN", "SUB_ADMIN", "USER"]) {
      expect(UserRoleEnum.safeParse(r).success).toBe(true);
      expect(updateUserRoleSchema.safeParse({ role: r }).success).toBe(true);
    }
    for (const r of [
      "admin",
      "sub_admin",
      "SUB-ADMIN",
      "OWNER",
      "",
      null,
      undefined,
      1,
    ]) {
      expect(UserRoleEnum.safeParse(r).success).toBe(false);
    }
    expect(updateUserRoleSchema.safeParse({}).success).toBe(false);
  });
});
