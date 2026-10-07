import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { createFeedback, deleteFeedback, getAllFeedbacks, updateFeedbackStatus } from "../services/feedback.service.js";
import { feedbackFilterQuerySchema } from "../validators/feedback.schema.js";
import { ZodError} from "zod";
import { ValidationError } from "../utils/errors.js";

export const createFeedbackHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const feedback = await createFeedback(req.body);
    sendSuccess(res, 201, feedback);
  }
);

export const getAllFeedbacksHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const validatedQuery = feedbackFilterQuerySchema.parse(req.query);
      const feedbacks = await getAllFeedbacks(validatedQuery.status);
      sendSuccess(res, 200, feedbacks);
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue: { message: string }) => issue.message)
          .join(", ");
        throw new ValidationError(`Query error: ${errorMessages}`);
      }
      throw error;
    }
  }
);


export const updateFeedbackStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const feedback = await updateFeedbackStatus(id as string, req.body.status);
    sendSuccess(res, 200, feedback);
  }
);


export const deleteFeedbackHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteFeedback(id as string);
    res.status(204).send();
  }
);