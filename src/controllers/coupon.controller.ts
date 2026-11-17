import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import {
  couponStatusBodySchema,
  listCouponsQuerySchema,
  searchCustomersQuerySchema,
} from "../validators/coupon.schema.js";
import {
  createCoupon,
  deleteCoupon,
  getCoupon,
  listCoupons,
  searchCouponCustomers,
  toggleCouponStatus,
  updateCoupon,
} from "../services/coupon.service.js";

function parseQueryOrThrow<T>(
  schema: { parse: (data: unknown) => T },
  query: unknown
): T {
  try {
    return schema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues
        .map((issue) => issue.message)
        .join(", ");
      throw new ValidationError(`Query error: ${errorMessages}`);
    }
    throw error;
  }
}

export const createCouponHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const coupon = await createCoupon(req.body, req.user!.id);
    sendSuccess(res, 201, coupon);
  }
);

export const updateCouponHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const coupon = await updateCoupon(id as string, req.body, req.user!.id);
    sendSuccess(res, 200, coupon);
  }
);

export const getAllCouponsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = parseQueryOrThrow(listCouponsQuerySchema, req.query);
    const result = await listCoupons(query);
    sendSuccess(res, 200, result);
  }
);

export const getCouponHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const coupon = await getCoupon(id as string);
    sendSuccess(res, 200, coupon);
  }
);

export const toggleCouponStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    // The body is optional: with { isActive } the coupon is set to exactly that,
    // without it the status is flipped.
    const body = couponStatusBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      throw new ValidationError(
        body.error.issues[0]?.message ?? "Invalid status"
      );
    }
    const coupon = await toggleCouponStatus(
      id as string,
      req.user!.id,
      body.data.isActive
    );
    sendSuccess(res, 200, coupon);
  }
);

export const deleteCouponHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteCoupon(id as string);
    res.status(204).send();
  }
);

export const searchCouponCustomersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { search } = parseQueryOrThrow(searchCustomersQuerySchema, req.query);
    const customers = await searchCouponCustomers(search);
    sendSuccess(res, 200, customers);
  }
);
