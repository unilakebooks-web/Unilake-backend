// Integration tests for the view-only share link (feature 14), through the real application over HTTP: only the
// queues and the login lookup are replaced. Neon TEST branch and local MinIO (a real web image is uploaded).
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: { addBulk: vi.fn(), getJob: vi.fn() },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/lib/auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response(null, { status: 404 })),
    api: { getSession: vi.fn(async () => null) },
  },
}));

import app from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import { deletePrefix, uploadFile } from "../../src/lib/r2.js";

const MARK = "__vitest_share__";
const RUN = Math.random().toString(36).slice(2, 8);
const H = 3600_000;
const NOW = Date.now();

let server: http.Server;
let port = 0;
let comicId: string;
const pageIds: string[] = [];
const sessionIds: string[] = [];
let image: Buffer;

type Res = {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  raw: Buffer;
};
function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined)
      headers["content-type"] = headers["content-type"] ?? "application/json";
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json: unknown = null;
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            /* not JSON */
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json,
            raw,
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface MkOptions {
  status?: string;
  order?: "CREATED" | "PAID" | "DELIVERED" | null;
  expiresInH?: number;
  sample?: boolean;
  marker?: "files" | "photo" | null;
  // which page numbers (1 and 2 are preview pages, 3 is paid) get a ready variant with an uploaded image
  ready?: number[];
  childName?: string;
}

async function mk(o: MkOptions = {}) {
  const session = await prisma.orderSession.create({
    data: {
      comicId,
      status: (o.status ?? "PREVIEW_READY") as never,
      expiresAt: new Date(NOW + (o.expiresInH ?? 24) * H),
      rawPhotoUrls: [`sessions/secret-photo-${RUN}.jpg`],
      bestPhotoUrl: `sessions/secret-best-${RUN}.jpg`,
      coverType: "HARDCOVER",
      shippingCountry: "IN",
      shippingName: `Private Person ${RUN}`,
      shippingLine1: `12 Secret Street ${RUN}`,
      shippingPhone: "9876501234",
      notificationEmail: `private-${RUN}@example.test`,
      childName: o.childName ?? "Aarav Kumar",
      isSample: !!o.sample,
    },
  });
  sessionIds.push(session.id);
  for (let i = 0; i < pageIds.length; i++) {
    await prisma.sessionPage.create({
      data: {
        orderSessionId: session.id,
        pageId: pageIds[i]!,
        isPreviewPage: i < 2,
      },
    });
  }
  let orderId: string | null = null;
  if (o.order) {
    const order = await prisma.order.create({
      data: {
        orderSessionId: session.id,
        amount: "499.00",
        currency: "INR",
        countryCode: "IN",
        coverType: "HARDCOVER",
        status: o.order,
        razorpayOrderId: `order_${RUN}_${session.id.slice(0, 8)}`,
        razorpayPaymentId:
          o.order === "CREATED" ? null : `pay_${RUN}_${session.id.slice(0, 8)}`,
        billNumber:
          o.order === "CREATED"
            ? null
            : `BILL-${RUN}-${session.id.slice(0, 6)}`,
        shippingName: `Private Person ${RUN}`,
        notificationEmail: `private-${RUN}@example.test`,
      },
    });
    orderId = order.id;
  }
  for (const number of o.ready ?? [1, 2]) {
    const pageId = pageIds[number - 1]!;
    const id = crypto.randomUUID();
    const key = `sessions/${session.id}/final/${id}.webp`;
    await uploadFile("public", key, image, "image/webp");
    await prisma.pageVersion.create({
      data: {
        id,
        orderSessionId: session.id,
        pageId,
        variantIndex: 0,
        status: "SD_READY",
        displayImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/sessions/${session.id}/final/${id}.png`,
        isSelected: false,
      },
    });
  }
  if (o.marker) {
    const t = new Date();
    await prisma.$executeRaw`UPDATE "order_sessions" SET "photoDeletedAt" = ${t}, "filesDeletedAt" = ${o.marker === "files" ? t : null} WHERE "id" = ${session.id}`;
  }
  return { id: session.id, orderId };
}

const share = (sessionId: string, body?: object) =>
  call(
    "POST",
    `/api/public/sessions/${sessionId}/share`,
    body === undefined ? {} : { body: JSON.stringify(body) }
  );
const tokenOf = (r: Res) => r.json?.data?.token as string;

async function cleanup() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  const ids = [...new Set([...sessionIds, ...sessions.map((s) => s.id)])];
  for (const id of ids)
    await deletePrefix("public", `sessions/${id}/`).catch(() => 0);
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.order.deleteMany({ where: { orderSessionId: { in: ids } } });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  sessionIds.length = 0;
}

beforeAll(async () => {
  await cleanup();
  image = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 4,
      background: { r: 200, g: 120, b: 60, alpha: 0.5 },
    },
  })
    .webp()
    .toBuffer();
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} Moon Story ${RUN}`,
      pageCount: 3,
      freePreviewPages: 2,
      status: "PUBLISHED",
    },
  });
  comicId = comic.id;
  for (let n = 1; n <= 3; n++) {
    pageIds.push(
      (
        await prisma.page.create({
          data: {
            comicId,
            pageNumber: n,
            hasFace: true,
            artworkUrl: "https://example.test/a.png",
            isPreviewPage: n <= 2,
          },
        })
      ).id
    );
  }
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
  await prisma.$disconnect();
});

describe("the shared book payload", () => {
  it("has exactly the allowed keys and leaks nothing private", async () => {
    const s = await mk({
      order: "PAID",
      status: "PAID_PAGES_READY",
      ready: [1, 2, 3],
    });
    const created = await share(s.id);
    expect(created.status).toBe(200);
    const read = await call("GET", `/api/public/shares/${tokenOf(created)}`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.json.data).sort()).toEqual([
      "comic",
      "complete",
      "lockedCount",
      "pages",
      "ready",
    ]);
    expect(Object.keys(read.json.data.comic).sort()).toEqual(["id", "title"]);
    expect(read.json.data.pages).toEqual([
      { pageNumber: 1 },
      { pageNumber: 2 },
      { pageNumber: 3 },
    ]);
    expect(read.json.data.lockedCount).toBe(0);
    expect(read.json.data.ready).toBe(true);
    expect(read.json.data.complete).toBe(true);
    const text = read.raw.toString("utf8");
    for (const secret of [
      s.id,
      s.orderId!,
      "Aarav",
      "Private Person",
      "Secret Street",
      "9876501234",
      "private-",
      "secret-photo",
      "secret-best",
      "BILL-",
      "pay_",
      "order_",
      "sessions/",
      "r2.dev",
      "localhost:9100",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("an unpaid preview lists only the free pages, counts the locked one and is incomplete when a page is missing", async () => {
    const s = await mk({ ready: [1, 3] }); // page 3 is locked (paid) and has a ready variant
    const t = tokenOf(await share(s.id));
    const read = await call("GET", `/api/public/shares/${t}`);
    expect(read.json.data.pages).toEqual([{ pageNumber: 1 }]);
    expect(read.json.data.lockedCount).toBe(1);
    expect(read.json.data.ready).toBe(true);
    expect(read.json.data.complete).toBe(false); // page 2 is free but not ready
    // the locked page's image is never served, even though a ready variant exists
    expect(
      (await call("GET", `/api/public/shares/${t}/pages/3/image`)).status
    ).toBe(404);
    expect(
      (await call("GET", `/api/public/shares/${t}/pages/2/image`)).status
    ).toBe(404);
  });

  it("a session with no page ready is not ready, and its image is the one 404", async () => {
    const s = await mk({ status: "CREATED", ready: [] });
    const t = tokenOf(await share(s.id));
    const read = await call("GET", `/api/public/shares/${t}`);
    expect(read.json.data).toMatchObject({
      pages: [],
      ready: false,
      complete: false,
      lockedCount: 1,
    });
  });

  it("shows the first name field only when the customer ticked it", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    expect(
      (await call("GET", `/api/public/shares/${t}`)).json.data
    ).not.toHaveProperty("childName");
    await share(s.id, { showName: true });
    expect(
      (await call("GET", `/api/public/shares/${t}`)).json.data.childName
    ).toBe("Aarav Kumar");
    // a body without the field leaves it on; {} too
    await share(s.id);
    await share(s.id, {});
    expect(
      (await call("GET", `/api/public/shares/${t}`)).json.data.childName
    ).toBe("Aarav Kumar");
    await share(s.id, { showName: false });
    expect(
      (await call("GET", `/api/public/shares/${t}`)).json.data
    ).not.toHaveProperty("childName");
  });
});

describe("the share images", () => {
  it("serves the web image with the headers a cross-origin page needs and no storage detail", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    const r = await call("GET", `/api/public/shares/${t}/pages/1/image`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/webp");
    expect(r.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(r.headers["x-robots-tag"]).toBe("noindex");
    expect(r.headers["cache-control"]).toBe("public, max-age=60");
    expect(r.headers["etag"]).toBeTruthy();
    expect(r.headers).not.toHaveProperty("content-disposition");
    expect(Object.keys(r.headers).filter((h) => h.startsWith("x-amz"))).toEqual(
      []
    );
    expect(r.headers.location).toBeUndefined();
    expect(r.raw.equals(image)).toBe(true);
  });

  it("serves a 1200 px wide JPEG card under 300 KB with its own ETag, and answers 304", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    const card = await call("GET", `/api/public/shares/${t}/pages/1/card.jpg`);
    expect(card.status).toBe(200);
    expect(card.headers["content-type"]).toBe("image/jpeg");
    expect(card.raw.length).toBeLessThanOrEqual(300 * 1024);
    const meta = await sharp(card.raw).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    // flattened: a half transparent source must not come out black
    const { data } = await sharp(card.raw)
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(40);
    const webpTag = (await call("GET", `/api/public/shares/${t}/pages/1/image`))
      .headers.etag;
    expect(card.headers.etag).toBeTruthy();
    expect(card.headers.etag).not.toBe(webpTag);
    const again = await call(
      "GET",
      `/api/public/shares/${t}/pages/1/card.jpg`,
      { headers: { "if-none-match": card.headers.etag as string } }
    );
    expect(again.status).toBe(304);
    expect(again.raw.length).toBe(0);
    expect(again.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(again.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("answers 304 for the web image on a matching or listed ETag, and HEAD without a body", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    const etag = (await call("GET", `/api/public/shares/${t}/pages/1/image`))
      .headers.etag as string;
    for (const value of [etag, `W/${etag}`, `"x", ${etag}`, "*"]) {
      expect(
        (
          await call("GET", `/api/public/shares/${t}/pages/1/image`, {
            headers: { "if-none-match": value },
          })
        ).status,
        value
      ).toBe(304);
    }
    const head = await call("HEAD", `/api/public/shares/${t}/pages/1/image`);
    expect(head.status).toBe(200);
    expect(head.raw.length).toBe(0);
    expect(head.headers.etag).toBe(etag);
  });

  it("answers 400 for a page number that is not a positive integer and 404 for any integer not in the book", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    for (const bad of ["0", "-1", "1.5", "abc", "01", "1e0", "%31x", "99999"]) {
      expect(
        (await call("GET", `/api/public/shares/${t}/pages/${bad}/image`))
          .status,
        bad
      ).toBe(400);
    }
    for (const missing of ["4", "99", "9999"]) {
      expect(
        (await call("GET", `/api/public/shares/${t}/pages/${missing}/image`))
          .status,
        missing
      ).toBe(404);
    }
  });

  it("answers a missing storage object with the 404 and no storage detail in any body", async () => {
    const s = await mk();
    await deletePrefix("public", `sessions/${s.id}/`);
    const t = tokenOf(await share(s.id));
    for (const path of ["image", "card.jpg"]) {
      const r = await call("GET", `/api/public/shares/${t}/pages/1/${path}`);
      expect(r.status).toBe(404);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.raw.toString("utf8")).not.toContain("sessions/");
    }
    expect(
      (await call("HEAD", `/api/public/shares/${t}/pages/1/image`)).status
    ).toBe(404);
  });

  it("never serves a stored url that is not this session's web image", async () => {
    const s = await mk();
    const t = tokenOf(await share(s.id));
    const base = config.r2.publicUrlBase.replace(/\/$/, "");
    for (const bad of [
      `${base}/sessions/${s.id}/final/x.png`,
      `${base}/sessions/${crypto.randomUUID()}/final/x.webp`,
      `${base}/sessions/${s.id}/final/../../x.webp`,
      `https://evil.example/sessions/${s.id}/final/x.webp`,
      `${base}/sessions/${s.id}/final/x.webp?x=1`,
    ]) {
      await prisma.pageVersion.updateMany({
        where: { orderSessionId: s.id },
        data: { displayImageUrl: bad },
      });
      for (const path of ["image", "card.jpg"]) {
        expect(
          (await call("GET", `/api/public/shares/${t}/pages/1/${path}`)).status,
          `${path} ${bad}`
        ).toBe(404);
      }
    }
  });
});

describe("a dead share is one answer", () => {
  const tryAll = async (t: string) => {
    const out: number[] = [];
    out.push((await call("GET", `/api/public/shares/${t}`)).status);
    out.push(
      (await call("GET", `/api/public/shares/${t}/pages/1/image`)).status
    );
    out.push(
      (await call("GET", `/api/public/shares/${t}/pages/1/card.jpg`)).status
    );
    out.push(
      (await call("HEAD", `/api/public/shares/${t}/pages/1/image`)).status
    );
    return out;
  };

  it("unknown, bad-shape and session-id tokens are all the same 404 with the same body", async () => {
    const s = await mk();
    const bodies = new Set<string>();
    for (const t of [
      "A".repeat(32),
      "A".repeat(31),
      "A".repeat(33),
      s.id,
      "..%2F..",
      "%0A",
    ]) {
      const r = await call("GET", `/api/public/shares/${t}`);
      expect(r.status, t).toBe(404);
      bodies.add(r.raw.toString("utf8"));
    }
    expect(bodies.size).toBe(1);
    expect(
      (await call("GET", `/api/public/shares/${"A".repeat(31)}%0A`)).status
    ).toBe(404);
  });

  it("revoke kills the page, the images, a matching conditional request and HEAD at once; sharing again rotates the token", async () => {
    const s = await mk();
    const t1 = tokenOf(await share(s.id));
    const etag = (await call("GET", `/api/public/shares/${t1}/pages/1/image`))
      .headers.etag as string;
    const del = await call("DELETE", `/api/public/sessions/${s.id}/share`);
    expect(del.status).toBe(204);
    expect(await tryAll(t1)).toEqual([404, 404, 404, 404]);
    expect(
      (
        await call("GET", `/api/public/shares/${t1}/pages/1/image`, {
          headers: { "if-none-match": etag },
        })
      ).status
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/public/sessions/${s.id}/share`)).status
    ).toBe(204); // idempotent
    const state = await call("GET", `/api/public/sessions/${s.id}/share`);
    expect(state.json.data).toEqual({
      available: true,
      active: false,
      token: null,
      showName: false,
    });
    const t2 = tokenOf(await share(s.id, { showName: true }));
    expect(t2).not.toBe(t1);
    expect(await tryAll(t1)).toEqual([404, 404, 404, 404]);
    expect((await tryAll(t2)).slice(0, 3)).toEqual([200, 200, 200]);
  });

  it("rotating resets the name flag unless the body sets it", async () => {
    const s = await mk();
    await share(s.id, { showName: true });
    await call("DELETE", `/api/public/sessions/${s.id}/share`);
    const r = await share(s.id);
    expect(r.json.data.showName).toBe(false);
    await call("DELETE", `/api/public/sessions/${s.id}/share`);
    expect((await share(s.id, { showName: true })).json.data.showName).toBe(
      true
    );
  });

  it("ends with the session: files deleted, an expired unpaid preview, a sample, a deleted photo of an unpaid preview", async () => {
    const files = await mk({ marker: "files" });
    const expired = await mk({ expiresInH: -2 });
    const photoOnly = await mk({ marker: "photo" });
    for (const s of [files, expired, photoOnly]) {
      // make the share first, then the session dies
      await prisma.sessionShare.create({
        data: {
          orderSessionId: s.id,
          token: Buffer.from(s.id.replace(/-/g, ""))
            .toString("base64url")
            .slice(0, 32),
        },
      });
    }
    for (const s of [files, expired, photoOnly]) {
      const t = (
        await prisma.sessionShare.findUniqueOrThrow({
          where: { orderSessionId: s.id },
        })
      ).token;
      expect(await tryAll(t), s.id).toEqual([404, 404, 404, 404]);
      expect(
        (await call("GET", `/api/public/sessions/${s.id}/share`)).json.data
          .available
      ).toBe(false);
      expect((await share(s.id)).status).toBe(404);
    }
  });

  it("stays shareable for an expired paid book, and for a paid book whose photo (only) was deleted", async () => {
    const paidExpired = await mk({
      status: "COMPLETED",
      order: "DELIVERED",
      expiresInH: -100,
    });
    const t = tokenOf(await share(paidExpired.id));
    expect((await tryAll(t)).slice(0, 3)).toEqual([200, 200, 200]);
    const paidPhotoGone = await mk({
      status: "COMPLETED",
      order: "DELIVERED",
      marker: "photo",
    });
    expect((await share(paidPhotoGone.id)).status).toBe(200);
    // deleting the files (feature 6) ends it
    await prisma.$executeRaw`UPDATE "order_sessions" SET "filesDeletedAt" = now() WHERE "id" = ${paidExpired.id}`;
    expect(await tryAll(t)).toEqual([404, 404, 404, 404]);
  });

  it("a sample cannot be shared; a missing session is 404; the state of a sample says not available", async () => {
    const sample = await mk({ sample: true });
    expect((await share(sample.id)).status).toBe(404);
    expect(
      (await call("DELETE", `/api/public/sessions/${sample.id}/share`)).status
    ).toBe(404);
    expect(
      (await call("GET", `/api/public/sessions/${sample.id}/share`)).json.data
    ).toEqual({
      available: false,
      active: false,
      token: null,
      showName: false,
    });
    const missing = crypto.randomUUID();
    expect((await share(missing)).status).toBe(404);
    expect(
      (await call("GET", `/api/public/sessions/${missing}/share`)).status
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/public/sessions/${missing}/share`)).status
    ).toBe(404);
    const gone = await mk({ marker: "files" });
    expect(
      (await call("DELETE", `/api/public/sessions/${gone.id}/share`)).status
    ).toBe(204);
    const fresh = await mk();
    expect(
      (await call("DELETE", `/api/public/sessions/${fresh.id}/share`)).status
    ).toBe(204); // no row yet
  });
});

describe("creating the link", () => {
  it("is idempotent and safe under concurrency, also after a revoke", async () => {
    const s = await mk();
    const first = await Promise.all(
      Array.from({ length: 10 }, () => share(s.id))
    );
    expect(first.every((r) => r.status === 200)).toBe(true);
    expect(new Set(first.map(tokenOf)).size).toBe(1);
    expect(
      await prisma.sessionShare.count({ where: { orderSessionId: s.id } })
    ).toBe(1);
    await call("DELETE", `/api/public/sessions/${s.id}/share`);
    const second = await Promise.all(
      Array.from({ length: 10 }, () => share(s.id))
    );
    expect(second.every((r) => r.status === 200)).toBe(true);
    expect(new Set(second.map(tokenOf)).size).toBe(1);
    expect(tokenOf(second[0]!)).not.toBe(tokenOf(first[0]!));
    expect(
      await prisma.sessionShare.count({ where: { orderSessionId: s.id } })
    ).toBe(1);
  });

  it("accepts no body, {} and a boolean; refuses anything else; sets no-store on every JSON route", async () => {
    const s = await mk();
    expect(
      (await call("POST", `/api/public/sessions/${s.id}/share`)).status
    ).toBe(200);
    for (const bad of [
      '{"showName":"true"}',
      '{"showName":1}',
      '{"showName":null}',
      "[]",
      '{"showName":true,"extra":1}',
      '{"other":1}',
    ]) {
      expect(
        (
          await call("POST", `/api/public/sessions/${s.id}/share`, {
            body: bad,
          })
        ).status,
        bad
      ).toBe(400);
    }
    for (const r of [
      await call("GET", `/api/public/sessions/${s.id}/share`),
      await share(s.id),
      await call("DELETE", `/api/public/sessions/${s.id}/share`),
      await call("GET", `/api/public/shares/${"A".repeat(32)}`),
      await share(crypto.randomUUID()),
    ]) {
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
    }
  });

  it("works for a session still being made (nothing to show yet)", async () => {
    const s = await mk({ status: "CREATED", ready: [] });
    expect((await share(s.id)).status).toBe(200);
  });
});

describe("existing public routes still answer as before", () => {
  it("the comic detail and the session read are untouched", async () => {
    const comic = await call("GET", `/api/public/comics/${comicId}`);
    expect(comic.status).toBe(200);
    const s = await mk();
    const session = await call("GET", `/api/public/sessions/${s.id}`);
    expect(session.status).toBe(200);
    expect(session.json.data.id).toBe(s.id);
    // a share token is not a session id and a session id is not a share token
    expect(
      (await call("GET", `/api/public/sessions/${"A".repeat(32)}`)).status
    ).not.toBe(200);
  });
});
