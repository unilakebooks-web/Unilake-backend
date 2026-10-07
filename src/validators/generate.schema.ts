import { z } from "zod";

export const generateSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});