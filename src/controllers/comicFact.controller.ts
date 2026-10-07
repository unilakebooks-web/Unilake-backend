import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import { adminComicFactQuerySchema } from "../validators/comicFact.schema.js";
import {
  createComicFact,
  deleteComicFact,
  listComicFactsAdmin,
  toggleComicFactStatus,
  updateComicFact,
} from "../services/comicFact.service.js";

// NOTE: this is the THIRD copy of this helper (see blog.controller.ts and
// faq.controller.ts). Kept identical rather than extracted so this module
// matches the two it is modelled on; pulling all three into src/utils/ is a
// worthwhile tidy-up, but not one to smuggle into an unrelated feature.
function parseQueryOrThrow<T>(schema: { parse: (data: unknown) => T }, query: unknown): T {
  try {
    return schema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues.map((issue) => issue.message).join(", ");
      throw new ValidationError(`Query error: ${errorMessages}`);
    }
    throw error;
  }
}

export const listComicFactsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;
    const query = parseQueryOrThrow(adminComicFactQuerySchema, req.query);

    const facts = await listComicFactsAdmin(comicId as string, query.placement);

    sendSuccess(res, 200, facts);
  }
);

export const createComicFactHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    const fact = await createComicFact(comicId as string, req.body);

    sendSuccess(res, 201, fact, "Fact added");
  }
);

export const updateComicFactHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { factId } = req.params;

    const fact = await updateComicFact(factId as string, req.body);

    sendSuccess(res, 200, fact);
  }
);

export const toggleComicFactStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { factId } = req.params;

    const fact = await toggleComicFactStatus(factId as string);

    sendSuccess(res, 200, fact);
  }
);

export const deleteComicFactHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { factId } = req.params;

    await deleteComicFact(factId as string);

    sendSuccess(res, 200, null, "Fact deleted");
  }
);
