import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { confirmPaymentWithRazorpay } from "../services/paymentConfirmation.service.js";
import { checkoutParamsSchema } from "../validators/checkout.schema.js";

// The customer's page asks whether its payment was received. No body: the server
// asks Razorpay itself (paymentConfirmation.service.ts).
export const confirmPaymentHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = checkoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(
        firstIssue?.message ?? "Invalid checkout params"
      );
    }

    const result = await confirmPaymentWithRazorpay(parsed.data.sessionId);

    sendSuccess(res, 200, result, "Payment status");
  }
);
