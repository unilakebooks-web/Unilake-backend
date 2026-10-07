import { z } from "zod";
import {
  MIN_DIMENSION_CM,
  MAX_DIMENSION_CM,
  MIN_WEIGHT_KG,
  MAX_WEIGHT_KG,
} from "../config/shipping.js";

// Query params for GET /api/admin/orders
// Sort is deliberately narrow — only createdAt / updatedAt. See DECISIONS.md
// notes on Section 7 for reasoning.
//
// pageSize hard cap = 100 (defensive). Default = 20 per admin's request.
// Frontend UI shows 20/page; the cap protects against a crafted request.

export const OrderSortByEnum = z.enum(["createdAt", "updatedAt"]);
export const SortOrderEnum = z.enum(["asc", "desc"]);

export const OrderStatusEnum = z.enum([
  "CREATED",
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export const listAdminOrdersQuerySchema = z.object({
  // Query strings arrive as strings; coerce to number and default.
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: OrderStatusEnum.optional(),
  search: z.string().trim().min(1).optional(),
  sortBy: OrderSortByEnum.default("createdAt"),
  sortOrder: SortOrderEnum.default("desc"),
});

export type ListAdminOrdersQueryInput = z.infer<typeof listAdminOrdersQuerySchema>;


// Body for POST /api/admin/orders/:orderId/confirm-dimensions
// Bounds sourced from shipping.ts to stay in sync with the service-layer
// re-validation inside pushDimensionsAssignAwbAndSchedulePickup.
// Zod rejects early with a clean 400; the service check is defence in depth.

export const confirmDimensionsBodySchema = z.object({
  length: z
    .number()
    .min(MIN_DIMENSION_CM, `length must be at least ${MIN_DIMENSION_CM} cm`)
    .max(MAX_DIMENSION_CM, `length must be at most ${MAX_DIMENSION_CM} cm`),
  breadth: z
    .number()
    .min(MIN_DIMENSION_CM, `breadth must be at least ${MIN_DIMENSION_CM} cm`)
    .max(MAX_DIMENSION_CM, `breadth must be at most ${MAX_DIMENSION_CM} cm`),
  height: z
    .number()
    .min(MIN_DIMENSION_CM, `height must be at least ${MIN_DIMENSION_CM} cm`)
    .max(MAX_DIMENSION_CM, `height must be at most ${MAX_DIMENSION_CM} cm`),
  weight: z
    .number()
    .min(MIN_WEIGHT_KG, `weight must be at least ${MIN_WEIGHT_KG} kg`)
    .max(MAX_WEIGHT_KG, `weight must be at most ${MAX_WEIGHT_KG} kg`),
});

export type ConfirmDimensionsBodyInput = z.infer<typeof confirmDimensionsBodySchema>;