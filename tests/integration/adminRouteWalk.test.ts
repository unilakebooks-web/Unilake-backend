// The safety net of the sub-admin role: walks EVERY route the real admin router
// registers and proves what each role can reach through requireStaff. It builds a stub router with the same
// (method, path) pairs, so no real handler, database or service runs, and puts requireStaff in front of it with
// the session lookup faked. Raw Node requests are used, not fetch, because fetch tidies "//" and dot segments
// before they leave the client and those are exactly the paths worth trying.
//
// A route added to src/routes/admin.ts makes this test fail until tests/fixtures/adminRouteClassification.ts
// lists it as staff or master on purpose.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk: vi.fn(), getJob: vi.fn() },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/auth.js", () => ({
  auth: {
    api: {
      // The role comes from a header of the test request; "none" means no session.
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const role = headers.get("x-test-role");
        if (!role || role === "none") return null;
        return { session: { id: "session-1" }, user: { id: "user-1", role } };
      }),
    },
  },
}));

import adminRoutes from "../../src/routes/admin.js";
import { requireStaff } from "../../src/middlewares/requireStaff.js";
import { errorHandler } from "../../src/middlewares/errorHandler.js";
import {
  MASTER_ROUTES,
  STAFF_ROUTES,
} from "../fixtures/adminRouteClassification.js";

type Registered = { method: string; path: string; key: string };

function registeredRoutes(router: unknown): Registered[] {
  const stack = (
    router as {
      stack: {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
      }[];
    }
  ).stack;
  const out: Registered[] = [];
  for (const layer of stack) {
    // The router has only plain routes (no use, route, all or param): anything else would be a way
    // to reach a handler that this walk does not see.
    if (!layer.route) {
      throw new Error(
        `Unexpected non-route layer in the admin router: ${layer.name}`
      );
    }
    for (const m of Object.keys(layer.route.methods)) {
      if (!layer.route.methods[m]) continue;
      const method = m.toUpperCase();
      out.push({
        method,
        path: layer.route.path,
        key: `${method} ${layer.route.path}`,
      });
    }
  }
  return out;
}

/** What is wrong between the registered routes and the committed classification (empty means in step). */
function classificationProblems(
  registered: string[],
  staff: string[],
  master: string[]
): string[] {
  const problems: string[] = [];
  const listed = new Set([...staff, ...master]);
  const seen = new Set(registered);
  for (const k of registered) {
    if (!listed.has(k))
      problems.push(`not classified (add it as staff or master): ${k}`);
  }
  for (const k of listed) {
    if (!seen.has(k))
      problems.push(`classified but not registered (remove it): ${k}`);
  }
  for (const k of staff) {
    if (master.includes(k))
      problems.push(`listed as both staff and master: ${k}`);
  }
  if (new Set(registered).size !== registered.length)
    problems.push("a route is registered twice");
  return problems;
}

const ID = "7f3c2d9e-1a4b-4c8d-9e5f-0a1b2c3d4e5f";
const fill = (path: string) => path.replace(/:[A-Za-z]+/g, ID);

let server: http.Server;
let port = 0;

async function call(
  role: string,
  method: string,
  path: string
): Promise<number> {
  return (await callFull(role, method, path)).status;
}

function callFull(
  role: string,
  method: string,
  path: string
): Promise<{ status: number; route: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        // The path is sent exactly as written (no tidying of "//" or dot segments).
        path: `/api/admin${path}`,
        headers: { "x-test-role": role },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            route: res.headers["x-route"] as string | undefined,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function inBatches<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<void>
) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run));
  }
}

const routes = registeredRoutes(adminRoutes);
const keys = routes.map((r) => r.key);
const STAFF = new Set(STAFF_ROUTES);
const methodsByPath = new Map<string, Set<string>>();
for (const r of routes) {
  if (!methodsByPath.has(r.path)) methodsByPath.set(r.path, new Set());
  methodsByPath.get(r.path)!.add(r.method);
}
const wrongMethod = (r: Registered) =>
  ["DELETE", "PUT", "PATCH", "POST"].find(
    (m) => !methodsByPath.get(r.path)!.has(m)
  )!;

beforeAll(async () => {
  const stub = express.Router();
  const register = stub as unknown as Record<
    string,
    (path: string, handler: express.RequestHandler) => void
  >;
  for (const r of routes) {
    // The answer names the route that handled the request, so a test can tell which route a path reached.
    register[r.method.toLowerCase()]!(r.path, (_req, res) => {
      res.setHeader("x-route", r.key);
      res.status(204).end();
    });
  }
  const app = express();
  app.use("/api/admin", requireStaff, stub);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("the admin routes are all classified", () => {
  it("every registered route is listed as staff or master, and nothing stale is listed", () => {
    expect(classificationProblems(keys, STAFF_ROUTES, MASTER_ROUTES)).toEqual(
      []
    );
  });

  it("the router has the routes the classification expects (count derived, not hard-coded)", () => {
    expect(keys.length).toBe(STAFF_ROUTES.length + MASTER_ROUTES.length);
    expect(keys.length).toBeGreaterThan(100);
  });

  it("the check itself reports an unclassified route, a stale entry and a double listing", () => {
    expect(
      classificationProblems(
        [...keys, "GET /reports"],
        STAFF_ROUTES,
        MASTER_ROUTES
      )
    ).toEqual(["not classified (add it as staff or master): GET /reports"]);
    expect(
      classificationProblems(keys, STAFF_ROUTES, [
        ...MASTER_ROUTES,
        "GET /gone",
      ])
    ).toEqual(["classified but not registered (remove it): GET /gone"]);
    expect(
      classificationProblems(keys, STAFF_ROUTES, [
        ...MASTER_ROUTES,
        STAFF_ROUTES[0]!,
      ])
    ).toContain(`listed as both staff and master: ${STAFF_ROUTES[0]}`);
    expect(
      classificationProblems([...keys, keys[0]!], STAFF_ROUTES, MASTER_ROUTES)
    ).toContain("a route is registered twice");
  });
});

describe("a sub-admin can reach exactly the staff routes", () => {
  it("every route, with case, trailing slash, HEAD, a wrong method and an empty segment", async () => {
    const failures: string[] = [];
    await inBatches(routes, 20, async (r) => {
      const isStaff = STAFF.has(r.key);
      const path = fill(r.path);
      const check = async (
        label: string,
        method: string,
        p: string,
        want: number
      ) => {
        const got = await callFull("SUB_ADMIN", method, p);
        if (got.status !== want) {
          failures.push(
            `${label} ${method} ${p}: wanted ${want}, got ${got.status}`
          );
        }
        // Whatever the path, a sub-admin may only ever be answered by a staff route.
        if (got.route !== undefined && !STAFF.has(got.route)) {
          failures.push(
            `${label} ${method} ${p}: reached the master route ${got.route}`
          );
        }
      };
      const open = isStaff ? 204 : 403;
      await check("exact", r.method, path, open);
      await check("upper-case", r.method, path.toUpperCase(), open);
      await check("trailing slash", r.method, `${path}/`, open);
      await check(
        "query string",
        r.method,
        `${path}?page=1&next=/comics`,
        open
      );
      if (r.method === "GET") await check("HEAD", "HEAD", path, open);
      await check("wrong method", wrongMethod(r), path, 403);
      await check("empty segment", r.method, `/${path}`, 403);
      await check(
        "empty segment inside",
        r.method,
        path.replace(/\/([^/]+)$/, "//$1"),
        403
      );
    });
    expect(failures).toEqual([]);
  });

  it("never reaches a master route by an encoded or dotted path", async () => {
    const tries: [string, string][] = [
      ["GET", `/orders/${ID}/../comics`],
      ["GET", `/orders/%2e%2e/comics`],
      ["GET", `/orders/%2E%2E/users`],
      ["GET", `/orders/..%2fcomics`],
      ["GET", `/orders/${ID}%2f..%2f..%2fusers`],
      ["PATCH", `/orders/${ID}/sent-to-printer/../../../users/x/role`],
      ["PATCH", `/orders/..%2fusers%2fx%2frole`],
      ["GET", `/orders;/comics`],
      ["GET", `/orders%00/comics`],
    ];
    for (const [m, p] of tries) {
      const got = await callFull("SUB_ADMIN", m, p);
      // Closed by the guard (403), not a route at all (404), or answered by a STAFF route (an encoded slash
      // stays inside one id, so "/orders/..%2fcomics" is the single-order route with a strange id, which its
      // handler rejects). Never answered by a master route.
      if (got.status === 403 || got.status === 404) continue;
      expect(STAFF.has(got.route ?? ""), `${m} ${p} reached ${got.route}`).toBe(
        true
      );
    }
  });

  it("an encoded slash in an id stays one id and is the same route Express picks", async () => {
    expect(
      await call("SUB_ADMIN", "GET", `/orders/${ID}%2Fretry-shiprocket`)
    ).toBe(204);
    expect(
      await call("SUB_ADMIN", "POST", `/orders/${ID}%2Fretry-shiprocket`)
    ).toBe(403);
  });
});

describe("the other roles", () => {
  it("a Master admin passes the guard on every route and variant", async () => {
    const failures: string[] = [];
    await inBatches(routes, 20, async (r) => {
      const path = fill(r.path);
      for (const [label, method, p] of [
        ["exact", r.method, path],
        ["upper-case", r.method, path.toUpperCase()],
        ["trailing slash", r.method, `${path}/`],
      ] as const) {
        const got = await call("ADMIN", method, p);
        if (got !== 204)
          failures.push(`${label} ${method} ${p}: wanted 204, got ${got}`);
      }
      // Whatever the router does with an unusual path, the guard itself never refuses a Master admin.
      for (const p of [`/${path}`, path.replace(/\/([^/]+)$/, "//$1")]) {
        const got = await call("ADMIN", wrongMethod(r), p);
        if (got === 401 || got === 403)
          failures.push(`${p}: the guard refused a Master admin (${got})`);
      }
    });
    expect(failures).toEqual([]);
  });

  it("a customer is refused 403 and an anonymous caller 401 on every route", async () => {
    const failures: string[] = [];
    await inBatches(routes, 20, async (r) => {
      const path = fill(r.path);
      const user = await call("USER", r.method, path);
      const none = await call("none", r.method, path);
      if (user !== 403) failures.push(`USER ${r.key}: wanted 403, got ${user}`);
      if (none !== 401)
        failures.push(`anonymous ${r.key}: wanted 401, got ${none}`);
    });
    expect(failures).toEqual([]);
  });

  it("a role we do not know, or a look-alike, is refused on every route", async () => {
    const failures: string[] = [];
    await inBatches(routes, 20, async (r) => {
      for (const role of ["admin", "sub_admin", "OWNER", "SUB_ADMINS"]) {
        const got = await call(role, r.method, fill(r.path));
        if (got !== 403)
          failures.push(`${role} ${r.key}: wanted 403, got ${got}`);
      }
    });
    expect(failures).toEqual([]);
  });
});
