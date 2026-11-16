import { z } from "zod";

// checkout is identified by the sessionId; the body is optional and only carries a coupon
export const checkoutParamsSchema = z.object({
  sessionId: z.string().uuid("Invalid session ID"),
});

// Optional body of POST /sessions/:sessionId/checkout.
//   couponCode omitted -> keep whatever coupon the order already has
//   couponCode "ABC"   -> apply (or replace with) that coupon
//   couponCode null    -> remove the coupon
export const checkoutBodySchema = z.object({
  couponCode: z.string().trim().max(64).nullable().optional(),
});

// Body of POST /sessions/:sessionId/coupon-preview
export const couponPreviewBodySchema = z.object({
  code: z.string().trim().min(1, "Enter a coupon code").max(64),
});