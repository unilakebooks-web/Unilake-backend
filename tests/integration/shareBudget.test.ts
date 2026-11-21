// What the share image routes do when the memory budget has no room: the 503 with Retry-After, never cached, and no
// storage detail. The budget is made smaller than one image by replacing the setting (feature 14).
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

vi.mock("../../src/config/share.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/share.js")>()),
  SHARE_BYTE_BUDGET: 100,
  SHARE_WAIT_MS: 30,
}));
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

const MARK = "__vitest_share_budget__";
let server: http.Server;
let port = 0;
let sessionId = "";
let token = "";

function get(
  path: string,
  method = "GET"
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function cleanup() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  for (const s of sessions)
    await deletePrefix("public", `sessions/${s.id}/`).catch(() => 0);
  const ids = sessions.map((s) => s.id);
  await prisma.pageVersion.deleteMany({
    where: { orderSessionId: { in: ids } },
  });
  await prisma.orderSession.deleteMany({ where: { id: { in: ids } } });
  await prisma.page.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} story`,
      pageCount: 1,
      freePreviewPages: 1,
      status: "PUBLISHED",
    },
  });
  const page = await prisma.page.create({
    data: {
      comicId: comic.id,
      pageNumber: 1,
      hasFace: true,
      artworkUrl: "https://example.test/a.png",
      isPreviewPage: true,
    },
  });
  const session = await prisma.orderSession.create({
    data: {
      comicId: comic.id,
      status: "PREVIEW_READY",
      expiresAt: new Date(Date.now() + 86_400_000),
      rawPhotoUrls: [],
    },
  });
  sessionId = session.id;
  await prisma.sessionPage.create({
    data: { orderSessionId: session.id, pageId: page.id, isPreviewPage: true },
  });
  const image = await sharp({
    create: { width: 800, height: 800, channels: 3, background: "#264653" },
  })
    .webp()
    .toBuffer();
  const id = crypto.randomUUID();
  const key = `sessions/${session.id}/final/${id}.webp`;
  await uploadFile("public", key, image, "image/webp");
  await prisma.pageVersion.create({
    data: {
      id,
      orderSessionId: session.id,
      pageId: page.id,
      variantIndex: 0,
      status: "SD_READY",
      displayImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
    },
  });
  token = (
    await prisma.sessionShare.create({
      data: { orderSessionId: session.id, token: "B".repeat(32) },
    })
  ).token;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await cleanup();
  await prisma.$disconnect();
});

describe("no room in the memory budget", () => {
  it("answers the image and the card with 503 and Retry-After, uncached and without detail", async () => {
    for (const path of ["image", "card.jpg"]) {
      const r = await get(`/api/public/shares/${token}/pages/1/${path}`);
      expect(r.status, path).toBe(503);
      expect(r.headers["retry-after"]).toBeTruthy();
      expect(r.headers["cache-control"]).toBe("no-store");
      // An answer that follows the image headers keeps neither the image's validator nor its type.
      expect(r.headers.etag).toBeUndefined();
      expect(r.headers["content-type"] ?? "").not.toMatch(/image/);
      expect(r.text).not.toContain("sessions/");
      expect(r.text).not.toContain(sessionId);
    }
  });

  it("still answers HEAD, which holds no memory", async () => {
    const head = await get(`/api/public/shares/${token}/pages/1/image`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
  });

  it("the JSON book read is unaffected", async () => {
    const r = await get(`/api/public/shares/${token}`);
    expect(r.status).toBe(200);
  });
});
