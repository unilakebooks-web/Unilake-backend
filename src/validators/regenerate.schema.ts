import { z } from "zod"

export const regeneratePageParamsSchema = z.object({
  sessionId: z.string().uuid(),
  pageNumber: z.coerce.number().int().positive(),
});