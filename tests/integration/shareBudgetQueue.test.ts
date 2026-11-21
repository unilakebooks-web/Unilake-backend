// The memory budget through the controller (feature 14): requests that do not fit wait their turn and are all
// served, and a client that leaves, queued or in flight, gives its reservation back. The budget is made big enough
// for exactly one image at a time by replacing the setting.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

vi.mock("../../src/config/share.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/share.js")>()),
  SHARE_BYTE_BUDGET: 20_000,
  SHARE_WAIT_MS: 8_000,
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

const MARK = "__vitest_share_queue__";
let server: http.Server;
let port = 0;
let token = "";
let image: Buffer;

function get(path: string): Promise<{ status: number; length: number }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let length = 0;
        res.on("data", (c) => (length += c.length));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, length }));
      })
      .on("error", reject);
  });
}

/** Starts a request and drops the connection at once. */
function abandon(path: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path });
    req.on("error", () => resolve());
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 5);
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
  // An image of between 10.5 and 19 KB: one fits in the 20 KB budget, two do not.
  for (let width = 40; width <= 200 && !image; width += 8) {
    const candidate = await sharp(randomBytes(width * width * 3), {
      raw: { width, height: width, channels: 3 },
    })
      .webp({ lossless: true })
      .toBuffer();
    if (candidate.length > 10_500 && candidate.length < 19_000)
      image = candidate;
  }
  expect(image).toBeTruthy();
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
  await prisma.sessionPage.create({
    data: { orderSessionId: session.id, pageId: page.id, isPreviewPage: true },
  });
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
      data: { orderSessionId: session.id, token: "Q".repeat(32) },
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

describe("the memory budget through the controller", () => {
  it("serves every request of a burst, one after the other, when only one image fits", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        get(`/api/public/shares/${token}/pages/1/image`)
      )
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(results.every((r) => r.length === image.length)).toBe(true);
  });

  it("gives the reservation back when clients leave, queued or in flight: later requests are still served", async () => {
    // Twenty clients that leave at once: more than the budget could ever hold if their reservations leaked.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        abandon(`/api/public/shares/${token}/pages/1/image`)
      )
    );
    for (let i = 0; i < 3; i++) {
      const r = await get(`/api/public/shares/${token}/pages/1/image`);
      expect(r.status).toBe(200);
    }
    // and a mixed burst: some leave, some stay
    const stay = Array.from({ length: 4 }, () =>
      get(`/api/public/shares/${token}/pages/1/image`)
    );
    await Promise.all(
      Array.from({ length: 6 }, () =>
        abandon(`/api/public/shares/${token}/pages/1/image`)
      )
    );
    expect((await Promise.all(stay)).map((r) => r.status)).toEqual([
      200, 200, 200, 200,
    ]);
  });
});
