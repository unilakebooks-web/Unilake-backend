import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { initiateCheckout } from "../services/checkout.service.js";
import { checkoutParamsSchema } from "../validators/checkout.schema.js";

export const initiateCheckoutHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // safeParse per DECISIONS: raw .parse() would escape as a 500 instead of a 400.
    const parsed = checkoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(firstIssue?.message ?? "Invalid checkout params");
    }

    const result = await initiateCheckout(parsed.data.sessionId);

    sendSuccess(res, 200, result, "Checkout initiated");
  }
);