import { z } from "zod";
import {
  MAX_PAGES_PER_REQUEST,
  MAX_WAIT_SECONDS,
} from "../config/pageRecovery.js";

export const orderPagesParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID"),
});

// GET /api/admin/orders/:orderId/pages?wait=25&sig=<signature of the last answer>
export const orderPagesQuerySchema = z.object({
  wait: z.coerce
    .number()
    .int("wait must be a whole number")
    .min(0, "wait cannot be negative")
    .max(MAX_WAIT_SECONDS, `wait is at most ${MAX_WAIT_SECONDS} seconds`)
    .optional(),
  sig: z.string().max(64).optional(),
});

// POST /api/admin/orders/:orderId/regenerate-pages
export const regenerateOrderPagesBodySchema = z.object({
  pageNumbers: z
    .array(
      z
        .number()
        .int("Page numbers are whole numbers")
        .positive("Page numbers start at 1")
    )
    .max(
      MAX_PAGES_PER_REQUEST,
      `At most ${MAX_PAGES_PER_REQUEST} pages at a time`
    )
    .optional(),
  force: z.boolean().optional(),
});
