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
  sentToPrinter: z.enum(["sent", "not_sent"]).optional(),
  // "true" = paid and ready, waiting for the customer to press Send to Print (the books reminder B is about).
  awaitingCustomerPrint: z.enum(["true"]).optional(),
  sortBy: OrderSortByEnum.default("createdAt"),
  sortOrder: SortOrderEnum.default("desc"),
});

export type ListAdminOrdersQueryInput = z.infer<typeof listAdminOrdersQuerySchema>;


// Body for PATCH /api/admin/orders/:orderId/sent-to-printer
// true marks the order as sent to the printer, false undoes the mark.

export const setSentToPrinterBodySchema = z.object({
  sent: z.boolean(),
});

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

// Body for PATCH /api/admin/orders/:orderId/shipping-address
// ⚠️ Mirrored in unilake-frontend components/admin/order/addressEditSchema.ts (the limits and
// the digit rules). The rules checked against the order itself (6-digit pincode for India,
// 10-digit phone once Shiprocket holds the order) are in services/orderAddress.service.ts
// and in the same frontend file.
// The country is deliberately not editable (price, currency and the bill follow
// it), so a country in the body is ignored. Zip and phone are digits only: the
// Shiprocket calls need integers, and a value that would break AWB generation
// is refused here instead.
// Shiprocket's own rules for this call, found by trying each field on a real test order:
// the name takes English letters, spaces, dots, hyphens and apostrophes only (no digits,
// no accents); the address lines take English text only (no accents, emoji or Devanagari)
// and at most 190 characters; the city at most 40 and the state at most 30. A value outside
// them is refused here, with the reason, instead of at Shiprocket with a generic failure.
const ENGLISH_TEXT = /^[\x20-\x7E\n]*$/;
export const editOrderAddressBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "At most 100 characters")
    .regex(
      /^[A-Za-z][A-Za-z .'-]*$/,
      "Shiprocket takes only English letters, spaces, dots, hyphens and apostrophes in the name"
    ),
  line1: z
    .string()
    .trim()
    .min(1, "Address line 1 is required")
    .max(190, "At most 190 characters (Shiprocket's limit)")
    .regex(ENGLISH_TEXT, "Shiprocket cannot take non-English letters or emoji in the address: write it in English letters"),
  line2: z
    .string()
    .trim()
    .max(190, "At most 190 characters (Shiprocket's limit)")
    .regex(ENGLISH_TEXT, "Shiprocket cannot take non-English letters or emoji in the address: write it in English letters")
    .optional(),
  city: z.string().trim().min(1, "City is required").max(40, "At most 40 characters (Shiprocket's limit)"),
  state: z.string().trim().min(1, "State is required").max(30, "At most 30 characters (Shiprocket's limit)"),
  zip: z.string().trim().regex(/^[1-9]\d{3,9}$/, "Pincode must be 4 to 10 digits, numbers only, not starting with 0"),
  phone: z.string().trim().regex(/^\d{7,15}$/, "Phone must be 7 to 15 digits, numbers only"),
  // The newest change the form was filled in from (0 when there was none). A save made on
  // top of a newer change is refused, so one admin cannot silently revert what another fixed.
  expectedSeq: z.number().int().min(0, "expectedSeq is required"),
});

// Body for POST /api/admin/orders/:orderId/shipping-address/mark-synced
// ⚠️ The 10-character minimum is also MIN_NOTE in the frontend MarkAddressSyncedDialog.tsx.
export const markAddressSyncedBodySchema = z.object({
  note: z.string().trim().min(10, "Say why, in at least 10 characters").max(500),
  // The newest change the admin saw when they opened the dialog (see markOrderAddressSynced).
  upToSeq: z.number().int().positive("upToSeq is required"),
});

export type ConfirmDimensionsBodyInput = z.infer<typeof confirmDimensionsBodySchema>;