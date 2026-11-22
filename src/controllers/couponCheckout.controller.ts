import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  listCouponOffers,
  previewCoupon,
} from "../services/couponCheckout.service.js";
import {
  checkoutParamsSchema,
  couponPreviewBodySchema,
} from "../validators/checkout.schema.js";

export const previewCouponHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = checkoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(
        firstIssue?.message ?? "Invalid checkout params"
      );
    }

    const body = couponPreviewBodySchema.safeParse(req.body);
    if (!body.success) {
      const firstIssue = body.error.issues[0];
      throw new ValidationError(firstIssue?.message ?? "Invalid coupon code");
    }

    const result = await previewCoupon(
      parsed.data.sessionId,
      req.user!.id,
      body.data.code,
      req.ip
    );

    sendSuccess(res, 200, result);
  }
);

export const listCouponOffersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = checkoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(
        firstIssue?.message ?? "Invalid checkout params"
      );
    }

    const result = await listCouponOffers(parsed.data.sessionId, req.user!.id);

    sendSuccess(res, 200, result);
  }
);
