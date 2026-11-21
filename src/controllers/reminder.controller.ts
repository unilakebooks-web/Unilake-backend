import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  getReminderSettings,
  updateReminderSettings,
} from "../services/reminderSettings.service.js";
import { getReminderStatus } from "../services/reminder.service.js";

export const getReminderSettingsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const setting = await getReminderSettings();
    sendSuccess(res, 200, setting);
  }
);

export const updateReminderSettingsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const setting = await updateReminderSettings(req.body);
    sendSuccess(res, 200, setting);
  }
);

export const getReminderStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const status = await getReminderStatus();
    sendSuccess(res, 200, status);
  }
);
