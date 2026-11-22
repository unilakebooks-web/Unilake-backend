import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { createHeroImage, deleteHeroImage, getActiveHeroImages, getAllHeroImages, getHeroImageUploadUrl, toggleHeroImageStatus, updateHeroImage } from "../services/heroImage.service.js";

export const getHeroImageUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getHeroImageUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const createHeroImageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const heroImage = await createHeroImage(req.body);
    sendSuccess(res, 201, heroImage);
  }
);

export const updateHeroImageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const heroImage = await updateHeroImage(id as string, req.body);
    sendSuccess(res, 200, heroImage);
  }
);

export const toggleHeroImageStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const heroImage = await toggleHeroImageStatus(id as string);
    sendSuccess(res, 200, heroImage);
  }
);



export const getAllHeroImagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const heroImages = await getAllHeroImages();
    sendSuccess(res, 200, heroImages);
  }
);


export const getActiveHeroImagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const heroImages = await getActiveHeroImages();
    sendSuccess(res, 200, heroImages);
  }
);


export const deleteHeroImageHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteHeroImage(id as string);
    res.status(204).send();
  }
);