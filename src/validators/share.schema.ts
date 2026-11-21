import { z } from "zod";

// The body of "share my book": nothing, or only whether the child's name may appear in the page title and preview.
export const createShareSchema = z
  .object({
    showName: z.boolean().optional(),
  })
  .strict()
  .optional();
