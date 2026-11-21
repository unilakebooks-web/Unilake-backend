import "../setup/env.js";
import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

// The link-preview card: 1200 px wide JPEG, flattened onto white, under 300 KB where the quality ladder can manage it.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/jobs/queues.js", () => ({
  sdGenerationQueue: {},
  shiprocketQueue: {},
  pdfCompilationQueue: {},
}));

import { toCardJpeg } from "../../src/controllers/share.controller.js";

describe("toCardJpeg", () => {
  it("makes a 1200 px wide JPEG under 300 KB from a flat page", async () => {
    const source = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: "#2a9d8f" },
    })
      .webp()
      .toBuffer();
    const card = await toCardJpeg(source);
    const meta = await sharp(card).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    expect(card.length).toBeLessThanOrEqual(300 * 1024);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a narrow source at its own width", async () => {
    const source = await sharp({
      create: { width: 600, height: 800, channels: 3, background: "#e76f51" },
    })
      .webp()
      .toBuffer();
    expect((await sharp(await toCardJpeg(source)).metadata()).width).toBe(600);
  });

  it("does not turn transparency black", async () => {
    const source = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const { data } = await sharp(await toCardJpeg(source))
      .extract({ left: 5, top: 5, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(200); // white, not black
  });

  it("serves the lowest quality result and says so when the page is too busy for 300 KB", async () => {
    const noise = randomBytes(1600 * 1600 * 3);
    const source = await sharp(noise, {
      raw: { width: 1600, height: 1600, channels: 3 },
    })
      .png()
      .toBuffer();
    const card = await toCardJpeg(source);
    expect((await sharp(card).metadata()).width).toBe(1200);
    expect(card.length).toBeGreaterThan(300 * 1024);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a page bigger than a page image can be, instead of decoding it", async () => {
    const huge = await sharp({
      create: { width: 3000, height: 3000, channels: 3, background: "#264653" },
    })
      .webp()
      .toBuffer();
    await expect(toCardJpeg(huge)).rejects.toThrow();
  });

  it("rejects bytes that are not an image", async () => {
    await expect(
      toCardJpeg(Buffer.from("this is not an image"))
    ).rejects.toThrow();
  });
});
