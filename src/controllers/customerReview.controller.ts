import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { createCustomerReview, deleteCustomerReview, getActiveCustomerReviews, getAllCustomerReviews, getCustomerReviewUploadUrl, toggleCustomerReviewStatus } from "../services/customerReview.service.js";




export const getCustomerReviewUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getCustomerReviewUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const createCustomerReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const review = await createCustomerReview(req.body);
    sendSuccess(res, 201, review);
  }
);

export const toggleCustomerReviewStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const review = await toggleCustomerReviewStatus(id as string);
    sendSuccess(res, 200, review);
  }
);

export const deleteCustomerReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteCustomerReview(id as string);
    res.status(204).send();
  }
);

export const getAllCustomerReviewsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const reviews = await getAllCustomerReviews();
    sendSuccess(res, 200, reviews);
  }
);

export const getActiveCustomerReviewsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const reviews = await getActiveCustomerReviews();
    sendSuccess(res, 200, reviews);
  }
);