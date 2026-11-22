import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { initiateCheckout } from "../services/checkout.service.js";
import {
  checkoutBodySchema,
  checkoutParamsSchema,
} from "../validators/checkout.schema.js";

export const initiateCheckoutHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // safeParse per DECISIONS: raw .parse() would escape as a 500 instead of a 400.
    const parsed = checkoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(firstIssue?.message ?? "Invalid checkout params");
    }

    // The body is optional; a checkout with no body behaves exactly as before.
    const body = checkoutBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      const firstIssue = body.error.issues[0];
      throw new ValidationError(firstIssue?.message ?? "Invalid checkout body");
    }

    // Checkout itself does not require a login (the session's owner was set
    // earlier), but changing a coupon does, so read the caller if there is one.
    let callerUserId: string | undefined;
    if (body.data.couponCode !== undefined) {
      try {
        const sessionData = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        if (sessionData?.user) callerUserId = sessionData.user.id;
      } catch (err) {
        // No valid session: the caller stays anonymous.
        logger.warn({ err }, "Could not read the caller on checkout");
      }
    }

    const result = await initiateCheckout(parsed.data.sessionId, {
      couponCode: body.data.couponCode,
      callerUserId,
      callerIp: req.ip,
    });

    sendSuccess(res, 200, result, "Checkout initiated");
  }
);