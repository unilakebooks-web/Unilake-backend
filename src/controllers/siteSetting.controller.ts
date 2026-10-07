import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  getSiteSettingAdmin,
  getSiteSettingPublic,
  updateSiteSetting,
} from "../services/siteSetting.service.js";

export const getPublicSiteSettingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const setting = await getSiteSettingPublic();
    sendSuccess(res, 200, setting);
  }
);

export const getAdminSiteSettingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const setting = await getSiteSettingAdmin();
    sendSuccess(res, 200, setting);
  }
);

export const updateSiteSettingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const setting = await updateSiteSetting(req.body);
    sendSuccess(res, 200, setting);
  }
);
