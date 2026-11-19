// The real application's /api/admin mount (src/app.ts): the route-walk test builds its own mount, so this is the test
// that fails if the guard in app.ts is removed, reverted to the old Master-only guard, or the admin router is mounted a
// second time without it. It sends requests through the real app; only the session lookup is faked. Every request here
// is refused by the guard or reads the (empty) test database, so no real handler writes anything.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk: vi.fn(), getJob: vi.fn() },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response(null, { status: 404 })),
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const role = headers.get("x-test-role");
        if (!role || role === "none") return null;
        return { session: { id: "session-1" }, user: { id: "user-1", role } };
      }),
    },
  },
}));

import app from "../../src/app.js";

let server: http.Server;
let port = 0;

function call(role: string, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { "x-test-role": role },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("the /api/admin mount of the real app", () => {
  it("answers 401 without a session on an order route and on a master route", async () => {
    expect(await call("none", "GET", "/api/admin/orders")).toBe(401);
    expect(await call("none", "GET", "/api/admin/users")).toBe(401);
  });

  it("refuses a customer on every kind of route", async () => {
    expect(await call("USER", "GET", "/api/admin/orders")).toBe(403);
    expect(await call("USER", "GET", "/api/admin/users")).toBe(403);
  });

  it("refuses a sub-admin on master routes, whatever the spelling", async () => {
    for (const path of [
      "/api/admin/users",
      "/api/admin/Users/",
      "/api/admin/comics",
      "/api/admin/customers/export",
      "/api/admin/stats/summary",
      "/api/admin/coupons",
      "/api/admin//orders",
      "/api/admin/orders/../comics",
    ]) {
      expect(await call("SUB_ADMIN", "GET", path), path).toBe(403);
    }
    expect(
      await call("SUB_ADMIN", "PATCH", "/api/admin/users/someone/role")
    ).toBe(403);
    expect(await call("SUB_ADMIN", "DELETE", "/api/admin/orders/someone")).toBe(
      403
    );
  });

  it("lets a sub-admin read the order list, with a query string and a different case (the old guard answered 403)", async () => {
    expect(
      await call("SUB_ADMIN", "GET", "/api/admin/orders?page=1&pageSize=5")
    ).toBe(200);
    expect(await call("SUB_ADMIN", "GET", "/api/admin/ORDERS/")).toBe(200);
  });

  it("applies the guard whatever the case of the prefix, and reaches the order write routes as a sub-admin (refused by their own validation, not by the guard)", async () => {
    expect(await call("SUB_ADMIN", "GET", "/API/ADMIN/users")).toBe(403);
    expect(await call("none", "GET", "/Api/Admin/Orders")).toBe(401);
    // POST and PATCH order routes with an empty body: the route's own validation answers 400.
    expect(
      await call(
        "SUB_ADMIN",
        "POST",
        "/api/admin/orders/00000000-0000-4000-8000-0000000000aa/confirm-dimensions"
      )
    ).toBe(400);
    expect(
      await call(
        "SUB_ADMIN",
        "PATCH",
        "/api/admin/orders/00000000-0000-4000-8000-0000000000aa/sent-to-printer"
      )
    ).toBe(400);
    // ...while a master write route is refused by the guard before any validation.
    expect(await call("SUB_ADMIN", "POST", "/api/admin/comics")).toBe(403);
  });

  it("lets a Master admin through to master routes", async () => {
    expect(
      await call("ADMIN", "GET", "/api/admin/orders?page=1&pageSize=5")
    ).toBe(200);
    expect(
      await call("ADMIN", "GET", "/api/admin/users?page=1&pageSize=1")
    ).toBe(200);
  });

  it("does not guard the customer API with the staff rules", async () => {
    // /api/user needs a login, and a sub-admin is also a customer.
    expect(await call("none", "GET", "/api/user/orders")).toBe(401);
    expect(await call("SUB_ADMIN", "GET", "/api/user/orders")).toBe(200);
  });
});
