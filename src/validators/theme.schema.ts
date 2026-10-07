import { z } from "zod";

export const createThemeSchema = z.object({
  name: z.string().trim().min(1, "Theme name is required"),
});
 
export const updateThemeSchema = z.object({
  name: z.string().trim().min(1, "Theme name is required"),
});

export const themeParamsSchema = z.object({
  themeId: z.string().uuid("Invalid theme ID"),
});