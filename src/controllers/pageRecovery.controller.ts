import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  getOrderPageStatus,
  regenerateOrderPages,
} from "../services/pageRecovery.service.js";
import {
  orderPagesParamsSchema,
  orderPagesQuerySchema,
  regenerateOrderPagesBodySchema,
} from "../validators/pageRecovery.schema.js";

// New file (not order.controller.ts) so other work on order handlers cannot conflict.

const firstIssue = (
  error: { issues: { message: string }[] },
  fallback: string
) => error.issues[0]?.message ?? fallback;

export const getOrderPagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const params = orderPagesParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new ValidationError(firstIssue(params.error, "Invalid order ID"));
    }
    const query = orderPagesQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError(firstIssue(query.error, "Invalid query"));
    }

    // Stop holding a long-poll once the browser has gone.
    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const result = await getOrderPageStatus(params.data.orderId, {
      wait: query.data.wait,
      sig: query.data.sig,
      isClosed: () => closed,
    });
    sendSuccess(res, 200, result);
  }
);

export const regenerateOrderPagesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const params = orderPagesParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new ValidationError(firstIssue(params.error, "Invalid order ID"));
    }
    const body = regenerateOrderPagesBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      throw new ValidationError(firstIssue(body.error, "Invalid request"));
    }

    const result = await regenerateOrderPages(
      params.data.orderId,
      req.user!.id,
      body.data
    );
    sendSuccess(res, 200, result);
  }
);
