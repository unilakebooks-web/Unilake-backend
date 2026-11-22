import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import { pageSeoSlugParamSchema } from "../validators/pageSeo.schema.js";
import type { PageSeoSlugParam } from "../validators/pageSeo.schema.js";
import {
  getPageSeoUploadUrl,
  listPageSeoAdmin,
  listPageSeoPublic,
  upsertPageSeo,
} from "../services/pageSeo.service.js";

// Same stand-in for a param validator as sitePage.controller: an unknown slug
// fails with a 400 naming the valid pages instead of reaching Prisma as a 500.
function parseSlugOrThrow(slug: unknown): PageSeoSlugParam {
  try {
    return pageSeoSlugParamSchema.parse(slug);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues
        .map((issue) => issue.message)
        .join(", ");
      throw new ValidationError(errorMessages);
    }
    throw error;
  }
}

export const getPageSeoUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getPageSeoUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const getAdminPageSeoHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const pages = await listPageSeoAdmin();
    sendSuccess(res, 200, pages);
  }
);

export const upsertPageSeoHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = parseSlugOrThrow(req.params.slug);
    const page = await upsertPageSeo(slug, req.body);
    sendSuccess(res, 200, page);
  }
);

export const getPublicPageSeoHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await listPageSeoPublic();
    sendSuccess(res, 200, result);
  }
);
