import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  getAdminHowItWorks,
  getHowItWorksUploadUrl,
  getPublicHowItWorks,
  updateHowItWorks,
} from "../services/howItWorks.service.js";

export const getPublicHowItWorksHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getPublicHowItWorks();
    sendSuccess(res, 200, result);
  }
);

export const getAdminHowItWorksHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getAdminHowItWorks();
    sendSuccess(res, 200, result);
  }
);

export const getHowItWorksUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getHowItWorksUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const updateHowItWorksHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await updateHowItWorks(req.body);
    sendSuccess(res, 200, result);
  }
);
