import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: holder.getSession } },
}));

import { requireStaff } from "../../src/middlewares/requireStaff.js";

const ID = "7f3c2d9e-1a4b-4c8d-9e5f-0a1b2c3d4e5f";

function sessionFor(role: unknown) {
  return {
    session: { id: "session-1" },
    user: { id: "user-1", role },
  };
}

async function run(method: string, path: string, url = path) {
  const req: Record<string, unknown> = { method, path, url, headers: {} };
  const next = vi.fn();
  await requireStaff(req as never, {} as never, next);
  const error = next.mock.calls[0]?.[0] as
    | { statusCode?: number; message?: string }
    | undefined;
  return { req, next, error, passed: next.mock.calls.length === 1 && !error };
}

beforeEach(() => {
  holder.getSession.mockReset();
});

describe("requireStaff", () => {
  it("answers 401 without a session", async () => {
    holder.getSession.mockResolvedValue(null);
    const r = await run("GET", "/orders");
    expect(r.error?.statusCode).toBe(401);
  });

  it("answers 401 for a session object without a session", async () => {
    holder.getSession.mockResolvedValue({ user: { id: "u", role: "ADMIN" } });
    expect((await run("GET", "/orders")).error?.statusCode).toBe(401);
  });

  it("lets a Master admin through every route and method, and sets the request's user", async () => {
    holder.getSession.mockResolvedValue(sessionFor("ADMIN"));
    for (const [m, p] of [
      ["GET", "/orders"],
      ["PATCH", `/users/${ID}/role`],
      ["DELETE", `/comics/${ID}`],
      ["GET", "/customers/export"],
      ["POST", "/anything/at/all"],
    ]) {
      const r = await run(m!, p!);
      expect(r.passed, `${m} ${p}`).toBe(true);
      expect((r.req.user as { id: string }).id).toBe("user-1");
      expect((r.req.session as { id: string }).id).toBe("session-1");
    }
  });

  it("lets a sub-admin through the order routes only", async () => {
    holder.getSession.mockResolvedValue(sessionFor("SUB_ADMIN"));
    expect((await run("GET", "/orders")).passed).toBe(true);
    expect((await run("POST", `/orders/${ID}/retry-shiprocket`)).passed).toBe(
      true
    );
    expect((await run("HEAD", `/orders/${ID}`)).passed).toBe(true);
    for (const [m, p] of [
      ["GET", "/comics"],
      ["GET", "/users"],
      ["PATCH", `/users/${ID}/role`],
      ["GET", "/customers"],
      ["DELETE", `/orders/${ID}`],
      ["GET", `//orders/${ID}`],
    ]) {
      const r = await run(m!, p!);
      expect(r.error?.statusCode, `${m} ${p}`).toBe(403);
      expect(r.error?.message).toBe("Forbidden: Admin privileges required.");
      expect(r.req.user).toBeUndefined();
    }
  });

  it("decides on the path without the query string, never on the full url", async () => {
    holder.getSession.mockResolvedValue(sessionFor("SUB_ADMIN"));
    // A paginated order list: req.path has no query string, req.url does.
    expect(
      (await run("GET", "/orders", "/orders?page=2&pageSize=20")).passed
    ).toBe(true);
    // A master path whose url mentions an order route is still refused.
    const r = await run("GET", "/comics", "/orders?x=1");
    expect(r.error?.statusCode).toBe(403);
  });

  it("gives a passed sub-admin request its user and session, and says why a missing session is 401", async () => {
    holder.getSession.mockResolvedValue(sessionFor("SUB_ADMIN"));
    const r = await run("GET", "/orders");
    expect((r.req.user as { id: string; role: string }).role).toBe("SUB_ADMIN");
    expect((r.req.session as { id: string }).id).toBe("session-1");
    holder.getSession.mockResolvedValue(null);
    expect((await run("GET", "/orders")).error?.message).toBe(
      "Unauthorized: Active session required."
    );
  });

  it("refuses a customer, a missing role, an unknown role and look-alike spellings, even on an order route", async () => {
    for (const role of [
      "USER",
      undefined,
      null,
      "",
      "admin",
      "Admin",
      "sub_admin",
      "SUB-ADMIN",
      "ADMIN ",
      "OWNER",
      1,
    ]) {
      holder.getSession.mockResolvedValue(sessionFor(role));
      const r = await run("GET", "/orders");
      expect(r.error?.statusCode, `role ${JSON.stringify(role)}`).toBe(403);
    }
  });

  it("passes a failing session lookup on to the error handler", async () => {
    const boom = new Error("session store down");
    holder.getSession.mockImplementation(async () => {
      throw boom;
    });
    const r = await run("GET", "/orders");
    expect(r.error).toBe(boom);
  });
});
