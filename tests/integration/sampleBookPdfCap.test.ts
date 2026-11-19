// The size cap on a sample PDF. Separate file because it replaces the cap with a tiny value for the
// whole file (a real over-the-cap PDF would be tens of megabytes). Test branch and local MinIO only.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {
    addBulk: vi.fn(async () => []),
    getJob: vi.fn(async () => null),
  },
  shiprocketQueue: { add: vi.fn() },
  pdfCompilationQueue: { add: vi.fn() },
}));
vi.mock("../../src/config/sample.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/sample.js")>()),
  MAX_SAMPLE_PDF_BYTES: 1000,
}));

import { prisma } from "../../src/lib/prisma.js";
import { config } from "../../src/config/env.js";
import { deletePrefix, uploadFile } from "../../src/lib/r2.js";
import {
  buildSamplePdf,
  createSample,
} from "../../src/services/sampleBook.service.js";

const MARK = "__vitest_sample_cap__";
const RUN = Math.random().toString(36).slice(2, 8);
let userId = "";
let comicId = "";
let sessionId = "";

async function cleanup() {
  const sessions = await prisma.orderSession.findMany({
    where: { comic: { title: { startsWith: MARK } } },
    select: { id: true },
  });
  for (const { id } of sessions)
    await deletePrefix("public", `sessions/${id}/`);
  await prisma.orderSession.deleteMany({
    where: { comic: { title: { startsWith: MARK } } },
  });
  await prisma.comic.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: MARK } } });
}

beforeAll(async () => {
  await cleanup();
  userId = `${MARK}-${RUN}`;
  await prisma.user.create({
    data: { id: userId, name: "Vitest", email: `${userId}@example.test` },
  });
  const comic = await prisma.comic.create({
    data: {
      title: `${MARK} ${RUN}`,
      pageCount: 1,
      freePreviewPages: 1,
      status: "UNPUBLISHED",
    },
  });
  comicId = comic.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("sample PDF size cap", () => {
  it("refuses a PDF larger than the cap with a clear message", async () => {
    const page = await prisma.page.create({
      data: {
        artworkUrl: "https://example.test/art.png",
        artworkWidth: 100,
        artworkHeight: 140,
        comicId,
        pageNumber: 1,
        isPreviewPage: true,
      },
    });
    const session = await createSample(
      {
        comicId,
        childName: "Cap",
        age: 5,
        pronounKey: "HE",
        pageIds: [page.id],
      },
      userId
    );
    sessionId = session.id;
    const png = await sharp({
      create: {
        width: 200,
        height: 300,
        channels: 3,
        background: { r: 10, g: 80, b: 160 },
        noise: { type: "gaussian", mean: 128, sigma: 40 },
      },
    })
      .png()
      .toBuffer();
    const key = `sessions/${sessionId}/final.png`;
    await uploadFile("public", key, png, "image/png");
    const version = await prisma.pageVersion.create({
      data: {
        orderSessionId: sessionId,
        pageId: page.id,
        variantIndex: 0,
        status: "SD_READY",
        finalImageUrl: `${config.r2.publicUrlBase.replace(/\/$/, "")}/${key}`,
      },
    });
    await expect(
      buildSamplePdf(sessionId, {
        selections: [{ pageId: page.id, pageVersionId: version.id }],
      })
    ).rejects.toThrow(/larger than .* MB\. Choose fewer pages/);
  });

  it("lets the next build start after a refusal", async () => {
    // pdfBuildRunning must be released even when the build throws.
    const version = await prisma.pageVersion.findFirstOrThrow({
      where: { orderSessionId: sessionId },
    });
    await expect(
      buildSamplePdf(sessionId, {
        selections: [{ pageId: version.pageId, pageVersionId: version.id }],
      })
    ).rejects.toThrow(/larger than/);
  });
});
