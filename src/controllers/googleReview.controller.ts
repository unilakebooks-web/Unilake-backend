import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  createGoogleReview,
  deleteGoogleReview,
  getActiveGoogleReviews,
  getAllGoogleReviews,
  getGoogleReviewUploadUrl,
  toggleGoogleReviewStatus,
  updateGoogleReview,
} from "../services/googleReview.service.js";

export const getGoogleReviewUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getGoogleReviewUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const createGoogleReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const review = await createGoogleReview(req.body);
    sendSuccess(res, 201, review);
  }
);

export const updateGoogleReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const review = await updateGoogleReview(id as string, req.body);
    sendSuccess(res, 200, review);
  }
);

export const toggleGoogleReviewStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const review = await toggleGoogleReviewStatus(id as string);
    sendSuccess(res, 200, review);
  }
);

export const deleteGoogleReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteGoogleReview(id as string);
    res.status(204).send();
  }
);

export const getAllGoogleReviewsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const reviews = await getAllGoogleReviews();
    sendSuccess(res, 200, reviews);
  }
);

export const getActiveGoogleReviewsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const reviews = await getActiveGoogleReviews();
    sendSuccess(res, 200, reviews);
  }
);
