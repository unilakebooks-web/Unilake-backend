import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  createPage,
  getPageArtworkUploadUrl,
  listComicPages,
  updatePage,
  deletePage,
  reorderComicPages,
  previewPageTextStamp,
} from "../services/page.service.js";
import {
  createPageSchema,
  getPageArtworkUploadUrlSchema,
  type PreviewPageStampInput,
  type ReorderPagesInput,
} from "../validators/page.schema.js";

export const getPageArtworkUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const input = getPageArtworkUploadUrlSchema.parse(req.body);
    const result = await getPageArtworkUploadUrl(comicId, input);

    sendSuccess(res, 200, result);
  }
);

export const createPageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const input = createPageSchema.parse(req.body);
    const result = await createPage(comicId, input);

    sendSuccess(res, 201, result);
  }
);


export const listComicPagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const pages = await listComicPages(comicId);

    sendSuccess(res, 200, pages);
  }
);

export const updatePageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { pageId } = req.params;

    if (!pageId || typeof pageId !== "string") {
      throw new ValidationError("pageId param is required");
    }

    const page = await updatePage(pageId, req.body);

    sendSuccess(res, 200, page);
  }
);

export const deletePageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { pageId } = req.params;

    if (!pageId || typeof pageId !== "string") {
      throw new ValidationError("pageId param is required");
    }

    await deletePage(pageId);

    res.status(204).send();
  }
);

export const reorderPagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const { orderedPageIds } = req.body as ReorderPagesInput;
    const pages = await reorderComicPages(comicId, orderedPageIds);

    sendSuccess(res, 200, pages, "Pages reordered successfully.");
  }
);

// POST /api/admin/pages/:pageId/preview-stamp
//
// Renders the page's text stamping with a caller-supplied name and pronoun, so
// the admin can see the real result while mapping bubbles. Text only — the face
// swap is a separate stage and is not involved.
export const previewPageStampHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { pageId } = req.params;

    if (!pageId || typeof pageId !== "string") {
      throw new ValidationError("pageId param is required");
    }

    const result = await previewPageTextStamp(
      pageId,
      req.body as PreviewPageStampInput
    );

    sendSuccess(res, 200, result);
  }
);
