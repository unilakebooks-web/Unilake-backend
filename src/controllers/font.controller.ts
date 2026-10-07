import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { createHash } from "crypto";
import {
  getFontUploadUrl,
  createFont,
  listComicFonts,
  updateFont,
  deleteFont,
  getFontFileMeta,
  getFontFileBytes,
} from "../services/font.service.js";
import {
  getFontUploadUrlSchema,
  createFontSchema,
} from "../validators/font.schema.js";


export const getFontUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const input = getFontUploadUrlSchema.parse(req.body);
    const result = await getFontUploadUrl(comicId, input);

    sendSuccess(res, 200, result);
  }
);


export const createFontHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const input = createFontSchema.parse(req.body);
    const result = await createFont(comicId, input);

    sendSuccess(res, 201, result);
  }
);


export const listComicFontsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const fonts = await listComicFonts(comicId);

    sendSuccess(res, 200, fonts);
  }
);

export const updateFontHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { fontId } = req.params;

    if (!fontId || typeof fontId !== "string") {
      throw new ValidationError("fontId param is required");
    }

    const font = await updateFont(fontId, req.body);

    sendSuccess(res, 200, font);
  }
);

// GET /api/admin/fonts/:fontId/file
//
// Streams the raw font file so the bubble-mapper canvas can draw text with the
// same glyphs the print renderer uses.
//
// ⚠️ Deliberately NOT wrapped in sendSuccess — the second exception to the
// envelope rule after /health. The body is a binary font file; base64 inside
// JSON would inflate it by a third for no benefit.
//
// Caching: `private, no-cache` + an ETag derived from the R2 key. The browser
// always revalidates, and an unchanged font answers 304 from one DB lookup
// without touching R2. Replacing a font's file changes its key, so the ETag
// changes and the new file is served — never a stale one.
export const getFontFileHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { fontId } = req.params;

    if (!fontId || typeof fontId !== "string") {
      throw new ValidationError("fontId param is required");
    }

    const meta = await getFontFileMeta(fontId);
    const etag = `"${createHash("sha1").update(meta.fileKey).digest("hex")}"`;

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");

    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const bytes = await getFontFileBytes(meta.fontId, meta.fileKey);

    res.setHeader("Content-Type", meta.contentType);
    res.setHeader("Content-Length", bytes.length.toString());
    res.status(200).end(bytes);
  }
);

export const deleteFontHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { fontId } = req.params;

    if (!fontId || typeof fontId !== "string") {
      throw new ValidationError("fontId param is required");
    }

    await deleteFont(fontId);

    res.status(204).send();
  }
);