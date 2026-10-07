import type { Request, Response } from "express";
import { createTheme, deleteTheme, updateTheme } from "../services/theme.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";

export const createThemeHandler = asyncHandler(async (req: Request, res: Response) => {
  const theme = await createTheme(req.body);
  sendSuccess(res, 201, theme);
});

export const updateThemeHandler = asyncHandler(async (req: Request, res: Response) => {
  const { themeId } = req.params;
  const theme = await updateTheme(themeId , req.body);
  sendSuccess(res, 200, theme);
});

export const deleteThemeHandler = asyncHandler(async (req: Request, res: Response) => {
  const { themeId } = req.params;
  await deleteTheme(themeId);
  res.status(204).send();
});


import { getAllThemes } from "../services/theme.service.js";

export const getAllThemesHandler = asyncHandler(async (req: Request, res: Response) => {
  const themes = await getAllThemes();
  sendSuccess(res, 200, themes);
});
