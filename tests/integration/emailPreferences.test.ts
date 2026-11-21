// Unsubscribe links and the marketing-consent box (feature 5), through the real application: only the session
// lookup is faked, so the real CORS, Helmet and JSON handling apply to the one-click POST a mail app sends.
import "../setup/env.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
        return {
          session: { id: "session-1" },
          user: {
            id: headers.get("x-test-user") ?? "vte-user",
            email: headers.get("x-test-email") ?? "someone@vitest-prefs.test",
            role,
          },
        };
      }),
    },
  },
}));

import app from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";

const DOMAIN = "@vitest-prefs.test";
const MARK = "vte-";
let server: http.Server;
let port = 0;
let seq = 0;

type Res = { status: number; headers: http.IncomingHttpHeaders; json: any };
function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const asUser = (id: string, email: string, role = "USER") => ({
  "x-test-role": role,
  "x-test-user": id,
  "x-test-email": email,
  "content-type": "application/json",
});
const json = (o: unknown) => JSON.stringify(o);

async function cleanup() {
  await prisma.reminderStop.deleteMany({
    where: { orderSessionId: { startsWith: MARK } },
  });
  await prisma.emailUnsubscribeToken.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.emailOptOut.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.marketingConsent.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

async function token(
  email: string,
  scope: "GLOBAL" | "ORDER_REMINDER" = "GLOBAL",
  sessionId: string | null = null
) {
  const t = `tok-${++seq}-abcdefghijklmnopqrstuvwxyz`;
  await prisma.emailUnsubscribeToken.create({
    data: { token: t, email, scope, orderSessionId: sessionId },
  });
  return t;
}
async function user(label: string, verified = true, provider?: string) {
  const email = `${label}-${++seq}${DOMAIN}`;
  const id = `${MARK}${seq}`;
  await prisma.user.create({
    data: { id, name: "T", email, emailVerified: verified },
  });
  if (provider) {
    await prisma.account.create({
      data: {
        id: `${MARK}acct-${seq}`,
        accountId: `a-${seq}`,
        providerId: provider,
        userId: id,
      },
    });
  }
  return { id, email };
}
const optOuts = (email: string) =>
  prisma.emailOptOut.count({ where: { email } });

beforeAll(async () => {
  await cleanup();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

describe("unsubscribe link", () => {
  it("GET describes the link and changes nothing (a mail scanner opening it unsubscribes nobody)", async () => {
    const email = `a${DOMAIN}`;
    const t = await token(email);
    const res = await call("GET", `/api/public/email/unsubscribe/${t}`);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ found: true, scope: "GLOBAL" });
    expect(JSON.stringify(res.json)).not.toContain(email);
    expect(await optOuts(email)).toBe(0);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("the one-click POST a mail app sends (form body, no Origin, no JSON) opts the address out, and repeating is harmless", async () => {
    const u = await user("b");
    await prisma.marketingConsent.create({
      data: {
        userId: u.id,
        email: u.email,
        optedInAt: new Date(),
        wordingVersion: "v1",
        source: "checkout",
      },
    });
    const t = await token(u.email);
    const post = () =>
      call("POST", `/api/public/email/unsubscribe/${t}`, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
    const first = await post();
    expect(first.status).toBe(200);
    expect(first.json.data).toEqual({ scope: "GLOBAL" });
    expect(await optOuts(u.email)).toBe(1);
    expect(
      (await prisma.marketingConsent.findUnique({ where: { userId: u.id } }))!
        .withdrawnAt
    ).not.toBeNull();
    expect((await post()).status).toBe(200);
    expect(await optOuts(u.email)).toBe(1);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("an unknown, malformed or purged token is a 404 with an honest message and writes nothing", async () => {
    for (const bad of [
      "x",
      "not-a-token-at-all-but-long-enough-1234",
      "../../etc/passwd",
    ]) {
      const res = await call(
        "POST",
        `/api/public/email/unsubscribe/${encodeURIComponent(bad)}`
      );
      expect(res.status).toBe(404);
      expect(res.json.error.message).toMatch(/expired or is not valid/);
    }
    const info = await call(
      "GET",
      "/api/public/email/unsubscribe/unknown-token-unknown-token-unknown"
    );
    expect(info.json.data).toEqual({ found: false, scope: null });
    expect(
      await prisma.emailOptOut.count({ where: { email: { endsWith: DOMAIN } } })
    ).toBe(0);
  });

  it("the per-book link stops reminder B for that order only and is not a global opt-out", async () => {
    const email = `c${DOMAIN}`;
    const t = await token(email, "ORDER_REMINDER", `${MARK}session-1`);
    const info = await call("GET", `/api/public/email/unsubscribe/${t}`);
    expect(info.json.data).toEqual({ found: true, scope: "ORDER_REMINDER" });
    const res = await call("POST", `/api/public/email/unsubscribe/${t}`);
    expect(res.json.data).toEqual({ scope: "ORDER_REMINDER" });
    expect(
      await prisma.reminderStop.count({
        where: { kind: "BOOK_NOT_SENT", orderSessionId: `${MARK}session-1` },
      })
    ).toBe(1);
    expect(await optOuts(email)).toBe(0);
    await call("POST", `/api/public/email/unsubscribe/${t}`); // again: still one row
    expect(
      await prisma.reminderStop.count({
        where: { orderSessionId: `${MARK}session-1` },
      })
    ).toBe(1);
  });
});

describe("marketing consent", () => {
  it("needs a signed-in user", async () => {
    expect((await call("GET", "/api/user/marketing-consent")).status).toBe(401);
    const put = await call("PUT", "/api/user/marketing-consent", {
      headers: { "content-type": "application/json" },
      body: json({ optedIn: true }),
    });
    expect(put.status).toBe(401);
  });

  it("ticking records the consent with the wording version; unticking withdraws it and keeps the evidence", async () => {
    const u = await user("d");
    const h = asUser(u.id, u.email.toUpperCase());
    expect(
      (await call("GET", "/api/user/marketing-consent", { headers: h })).json
        .data
    ).toMatchObject({ optedIn: false });
    const on = await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: true }),
    });
    expect(on.json.data).toMatchObject({ optedIn: true });
    const row = await prisma.marketingConsent.findUnique({
      where: { userId: u.id },
    });
    expect(row).toMatchObject({
      email: u.email,
      wordingVersion: "v1",
      source: "checkout",
      withdrawnAt: null,
    });
    expect(
      (await call("GET", "/api/user/marketing-consent", { headers: h })).json
        .data
    ).toMatchObject({ optedIn: true });
    // ticking twice is idempotent
    await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: true }),
    });
    expect(
      await prisma.marketingConsent.count({ where: { userId: u.id } })
    ).toBe(1);
    const off = await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: false }),
    });
    expect(off.json.data).toMatchObject({ optedIn: false });
    expect(
      (await prisma.marketingConsent.findUnique({ where: { userId: u.id } }))!
        .withdrawnAt
    ).not.toBeNull();
    expect(
      (await call("GET", "/api/user/marketing-consent", { headers: h })).json
        .data
    ).toMatchObject({ optedIn: false });
  });

  it("takes no user id or address from the body, and refuses a non-boolean", async () => {
    const u = await user("e");
    const other = await user("e2");
    const h = asUser(u.id, u.email);
    const res = await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: true, userId: other.id, email: other.email }),
    });
    expect(res.status).toBe(400);
    expect(
      await prisma.marketingConsent.count({
        where: { userId: { in: [u.id, other.id] } },
      })
    ).toBe(0);
    expect(
      (
        await call("PUT", "/api/user/marketing-consent", {
          headers: h,
          body: json({ optedIn: "yes" }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call("PUT", "/api/user/marketing-consent", {
          headers: h,
          body: json({}),
        })
      ).status
    ).toBe(400);
  });

  it("the newer action wins: ticking after an unsubscribe clears the opt-out; an unsubscribe after ticking withdraws it", async () => {
    const u = await user("f");
    const h = asUser(u.id, u.email);
    await prisma.emailOptOut.create({ data: { email: u.email } });
    await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: true }),
    });
    expect(await optOuts(u.email)).toBe(0);
    const t = await token(u.email);
    await call("POST", `/api/public/email/unsubscribe/${t}`);
    expect(await optOuts(u.email)).toBe(1);
    expect(
      (await call("GET", "/api/user/marketing-consent", { headers: h })).json
        .data
    ).toMatchObject({ optedIn: false });
  });

  it("the box is offered only to accounts whose address can be trusted: verified, or a social sign-in", async () => {
    const plain = await user("h1", false);
    const social = await user("h2", false, "facebook");
    const verified = await user("h3", true);
    const get = (u: { id: string; email: string }) =>
      call("GET", "/api/user/marketing-consent", {
        headers: asUser(u.id, u.email),
      });
    expect((await get(plain)).json.data).toEqual({
      optedIn: false,
      canTick: false,
    });
    expect((await get(social)).json.data).toEqual({
      optedIn: false,
      canTick: true,
    });
    expect((await get(verified)).json.data).toEqual({
      optedIn: false,
      canTick: true,
    });
    // a social sign-in can tick even though the account is not marked verified
    const on = await call("PUT", "/api/user/marketing-consent", {
      headers: asUser(social.id, social.email),
      body: json({ optedIn: true }),
    });
    expect(on.status).toBe(200);
    expect(
      await prisma.marketingConsent.count({ where: { userId: social.id } })
    ).toBe(1);
  });

  it("an account with an unverified address cannot tick the box: it is told so, nothing is stored, and nobody's unsubscribe is cleared", async () => {
    const u = await user("g", false);
    const h = asUser(u.id, u.email);
    await prisma.emailOptOut.create({ data: { email: u.email } });
    const res = await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: true }),
    });
    expect(res.status).toBe(403);
    expect(res.json.error.message).toMatch(/verify your email/i);
    expect(await optOuts(u.email)).toBe(1); // the unsubscribe stands
    expect(
      await prisma.marketingConsent.count({ where: { userId: u.id } })
    ).toBe(0);
    // unticking is always allowed
    const off = await call("PUT", "/api/user/marketing-consent", {
      headers: h,
      body: json({ optedIn: false }),
    });
    expect(off.status).toBe(200);
  });
});

describe("the admin email routes are for the Master admin only", () => {
  it("refuses a sub-admin and a customer on reminders and broadcast, and writes nothing", async () => {
    const before = await prisma.broadcast.count();
    for (const role of ["SUB_ADMIN", "USER"]) {
      const h = asUser("vte-x", `x${DOMAIN}`, role);
      for (const [method, path] of [
        ["GET", "/api/admin/reminders/settings"],
        ["PATCH", "/api/admin/reminders/settings"],
        ["GET", "/api/admin/reminders/status"],
        ["GET", "/api/admin/broadcasts"],
        ["GET", "/api/admin/broadcasts/audience"],
        ["POST", "/api/admin/broadcasts"],
        ["POST", "/api/admin/broadcasts/some-id/send"],
        ["POST", "/api/admin/broadcasts/some-id/test"],
        ["POST", "/api/admin/broadcasts/some-id/cancel"],
      ] as const) {
        const res = await call(method, path, {
          headers: h,
          body: method === "GET" ? undefined : json({}),
        });
        expect(res.status, `${role} ${method} ${path}`).toBe(403);
      }
    }
    expect(await prisma.broadcast.count()).toBe(before);
  });

  it("a signed-out caller gets 401", async () => {
    expect((await call("GET", "/api/admin/broadcasts")).status).toBe(401);
  });
});
