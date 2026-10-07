import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import { sitePageSlugParamSchema } from "../validators/sitePage.schema.js";
import type { SitePageSlugParam } from "../validators/sitePage.schema.js";
import {
  getSitePageAdmin,
  getSitePagePublic,
  listSitePagesAdmin,
  toggleSitePageStatus,
  upsertSitePage,
} from "../services/sitePage.service.js";

/**
 * There is no validateParams middleware in this codebase — blog.controller's
 * parseQueryOrThrow is the established stand-in for the same problem on the
 * query string, and this mirrors it for route params.
 *
 * Screening the slug here means an unknown value fails with a 400 naming the
 * valid options, rather than reaching Prisma and surfacing as a 500.
 */
function parseSlugOrThrow(slug: unknown): SitePageSlugParam {
  try {
    return sitePageSlugParamSchema.parse(slug);
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

export const getAdminSitePagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const pages = await listSitePagesAdmin();
    sendSuccess(res, 200, pages);
  }
);

export const getAdminSitePageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = parseSlugOrThrow(req.params.slug);
    const page = await getSitePageAdmin(slug);
    sendSuccess(res, 200, page);
  }
);

export const upsertSitePageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = parseSlugOrThrow(req.params.slug);
    const page = await upsertSitePage(slug, req.body);
    sendSuccess(res, 200, page);
  }
);

export const toggleSitePageStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = parseSlugOrThrow(req.params.slug);
    const page = await toggleSitePageStatus(slug);
    sendSuccess(res, 200, page);
  }
);

export const getPublicSitePageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = parseSlugOrThrow(req.params.slug);
    const page = await getSitePagePublic(slug);
    sendSuccess(res, 200, page);
  }
);
