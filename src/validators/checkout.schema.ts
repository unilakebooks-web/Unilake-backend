import { z } from "zod";

// checkout does not take any body cause checkout only requries the sessionId
export const checkoutParamsSchema = z.object({
  sessionId: z.string().uuid("Invalid session ID"),
});