// The web-sized WebP that comic thumbnails and hero slides are saved as. Real
// image processing, with R2 replaced by stubs so nothing leaves the machine.
import "../setup/env.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("../../src/lib/r2.js", () => ({
  downloadFileToBuffer: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import {
  deleteFile,
  downloadFileToBuffer,
  uploadFile,
} from "../../src/lib/r2.js";
import { buildThumbnailImage } from "../../src/lib/image.js";
import {
  deleteUploadedFiles,
  optimiseUploadedImage,
  optimiseUploadedImages,
} from "../../src/services/imageUpload.service.js";
import { ValidationError } from "../../src/utils/errors.js";

const download = vi.mocked(downloadFileToBuffer);
const upload = vi.mocked(uploadFile);
const remove = vi.mocked(deleteFile);

/** A noisy picture, so the PNG is large and the size drop is real. */
const picture = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer();

beforeEach(() => {
  vi.resetAllMocks();
  upload.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
});

describe("buildThumbnailImage", () => {
  it("caps the long edge at 1200 px, keeps the aspect ratio and returns WebP", async () => {
    const out = await buildThumbnailImage(await picture(3000, 2000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(800);
  });

  it("is much smaller than the original", async () => {
    const original = await picture(2400, 1600);
    const out = await buildThumbnailImage(original);
    expect(out.length).toBeLessThan(original.length / 3);
  });

  it("does not enlarge a small image", async () => {
    const meta = await sharp(
      await buildThumbnailImage(await picture(400, 300))
    ).metadata();
    expect([meta.width, meta.height]).toEqual([400, 300]);
  });

  it("handles a tall image by its long edge", async () => {
    const meta = await sharp(
      await buildThumbnailImage(await picture(1500, 3000))
    ).metadata();
    expect([meta.width, meta.height]).toEqual([600, 1200]);
  });

  it("applies the camera's orientation before dropping it", async () => {
    const rotated = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const meta = await sharp(await buildThumbnailImage(rotated)).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it("keeps transparency", async () => {
    const png = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    expect(
      (await sharp(await buildThumbnailImage(png)).metadata()).hasAlpha
    ).toBe(true);
  });

  it("refuses bytes that are not an image, with a customer-safe message", async () => {
    const promise = buildThumbnailImage(Buffer.from("not an image"));
    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    await expect(promise).rejects.toThrow(/could not be read/);
  });
});

describe("optimiseUploadedImages", () => {
  const RAW = "comics/temp/";

  it("stores a WebP under the folder, in order, and reports the raw keys", async () => {
    download.mockResolvedValue(await picture(1600, 1200));
    const result = await optimiseUploadedImages(
      [`${RAW}a.png`, `${RAW}b.png`],
      "comics/thumbnails",
      RAW
    );

    expect(result.map((r) => r.originalKey)).toEqual([
      `${RAW}a.png`,
      `${RAW}b.png`,
    ]);
    for (const r of result) {
      expect(r.key).toMatch(/^comics\/thumbnails\/[0-9a-f-]{36}\.webp$/);
    }
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]![0]).toBe("public");
    expect(upload.mock.calls[0]![3]).toBe("image/webp");
    expect(
      await sharp(upload.mock.calls[0]![2] as Buffer).metadata()
    ).toMatchObject({
      format: "webp",
      width: 1200,
    });
  });

  it("never deletes a raw upload itself (the caller does, after saving)", async () => {
    download.mockResolvedValue(await picture(300, 200));
    await optimiseUploadedImages([`${RAW}x.png`], "f", RAW);
    expect(remove).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty list", async () => {
    expect(await optimiseUploadedImages([], "f", RAW)).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });

  it("says the image was not found when R2 cannot return it", async () => {
    download.mockRejectedValue(new Error("NoSuchKey"));
    await expect(
      optimiseUploadedImages([`${RAW}gone.png`], "f", RAW)
    ).rejects.toThrow(/not found/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a key that is not a fresh upload, without reading or deleting anything", async () => {
    const refused = [
      "comics/thumbnails/0b0c1d2e-3f40-4a51-8b62-73849a5b6c7d.webp", // an optimised file
      "comics/temp/0b0c1d2e-3f40-4a51-8b62-73849a5b6c7d.webp", // looks like one
      "sessions/abc/final/page.png", // some other file in the bucket
      "other/x.png",
    ];
    for (const key of refused) {
      await expect(
        optimiseUploadedImages([key], "comics/thumbnails", RAW)
      ).rejects.toThrow(/not valid/i);
    }
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("accepts a raw upload whose name ends in .webp", async () => {
    download.mockResolvedValue(await picture(200, 200));
    const key = `${RAW}0b0c1d2e-3f40-4a51-8b62-73849a5b6c7d-cover.webp`;
    const [result] = await optimiseUploadedImages([key], "f", RAW);
    expect(result!.originalKey).toBe(key);
  });

  it("removes the ones already written when another fails, and throws", async () => {
    const good = await picture(300, 200);
    download.mockImplementation(async (_bucket, key) => {
      if (key === `${RAW}bad.png`) return Buffer.from("not an image");
      return good;
    });

    await expect(
      optimiseUploadedImages(
        [`${RAW}a.png`, `${RAW}bad.png`, `${RAW}c.png`],
        "folder",
        RAW
      )
    ).rejects.toBeInstanceOf(ValidationError);

    const written = upload.mock.calls.map((c) => c[1]).sort();
    const removed = remove.mock.calls.map((c) => c[1]).sort();
    expect(written).toHaveLength(2);
    expect(removed).toEqual(written);
  });

  it("stops after the batch that failed, and removes what earlier batches wrote", async () => {
    const good = await picture(300, 200);
    download.mockImplementation(async (_bucket, key) => {
      if (key === `${RAW}bad.png`) return Buffer.from("not an image");
      return good;
    });

    // Batches of three: [a b c] succeed, [bad d e] fails, [f] is never started.
    await expect(
      optimiseUploadedImages(
        ["a", "b", "c", "bad", "d", "e", "f"].map((n) => `${RAW}${n}.png`),
        "folder",
        RAW
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(download.mock.calls.map((c) => c[1])).not.toContain(`${RAW}f.png`);
    const written = upload.mock.calls.map((c) => c[1]).sort();
    expect(written).toHaveLength(5);
    expect(remove.mock.calls.map((c) => c[1]).sort()).toEqual(written);
  });

  it("works on at most three images at the same time", async () => {
    const good = await picture(300, 200);
    let running = 0;
    let peak = 0;
    download.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return good;
    });

    const keys = Array.from({ length: 8 }, (_, i) => `${RAW}${i}.png`);
    const result = await optimiseUploadedImages(keys, "f", RAW);

    expect(result.map((r) => r.originalKey)).toEqual(keys);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("optimiseUploadedImage", () => {
  it("returns the single result", async () => {
    download.mockResolvedValue(await picture(200, 100));
    const result = await optimiseUploadedImage(
      "hero-images/raw-1.png",
      "hero-images",
      "hero-images/"
    );
    expect(result.originalKey).toBe("hero-images/raw-1.png");
    expect(result.key).toMatch(/^hero-images\/[0-9a-f-]{36}\.webp$/);
  });
});

describe("deleteUploadedFiles", () => {
  it("deletes each raw upload", async () => {
    await deleteUploadedFiles(["a", "b"]);
    expect(remove.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
  });

  it("keeps going and never throws when one delete fails", async () => {
    remove
      .mockRejectedValueOnce(new Error("R2 down"))
      .mockResolvedValue(undefined);
    await expect(deleteUploadedFiles(["a", "b", "c"])).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(3);
  });
});
