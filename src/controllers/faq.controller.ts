import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import {
  adminFaqQuerySchema,
  publicFaqQuerySchema,
} from "../validators/faq.schema.js";
import {
  createFaq,
  deleteFaq,
  getActiveFaqs,
  listFaqs,
  reorderFaqs,
  toggleFaqStatus,
  updateFaq,
} from "../services/faq.service.js";

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

export const createFaqHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const faq = await createFaq(req.body);
    sendSuccess(res, 201, faq);
  }
);

export const updateFaqHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const faq = await updateFaq(id as string, req.body);
    sendSuccess(res, 200, faq);
  }
);

export const getAllFaqsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = parseQueryOrThrow(adminFaqQuerySchema, req.query);
    const faqs = await listFaqs(query.placement);
    sendSuccess(res, 200, faqs);
  }
);

export const getActiveFaqsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = parseQueryOrThrow(publicFaqQuerySchema, req.query);
    const faqs = await getActiveFaqs(query.placement);
    sendSuccess(res, 200, faqs);
  }
);

export const toggleFaqStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const faq = await toggleFaqStatus(id as string);
    sendSuccess(res, 200, faq);
  }
);

export const reorderFaqsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const faqs = await reorderFaqs(req.body.orderedIds);
    sendSuccess(res, 200, faqs);
  }
);

export const deleteFaqHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteFaq(id as string);
    res.status(204).send();
  }
);
