import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  listUserOrders,
  getUserOrder,
  getTrackingForUser,
  listAdminOrders,
  getAdminOrderDetail,
} from "../services/order.service.js";
import { listAdminOrdersQuerySchema } from "../validators/order.schema.js";
import { pushDimensionsAssignAwbAndSchedulePickup, retryPhaseAForFailedOrder, getLabelForOrder, refreshTrackingForOrder} from "../services/shiprocket.service.js";
import { z } from "zod";

export const listUserOrdersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const orders = await listUserOrders(userId);

    sendSuccess(res, 200, orders);
  }
);

export const getUserOrderHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      throw new ValidationError("Order ID is required");
    }

    const userId = req.user!.id;

    const order = await getUserOrder(id, userId);

    sendSuccess(res, 200, order);
  }
);


// GET /api/user/orders/:orderId/tracking
// Auth: requireLoggedIn (applied at router mount in app.ts)
// Returns customer-facing shipment status. Raw Shiprocket text stays admin-only.

const trackingParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const getUserOrderTrackingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = trackingParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    const userId = req.user!.id;
    const tracking = await getTrackingForUser(parseResult.data.orderId, userId);

    sendSuccess(res, 200, tracking);
  }


);

// GET /api/admin/orders
// Auth: requireAdmin (applied at router mount in app.ts)
// Paginated, searchable, filterable list of every order in the system.

export const listAdminOrdersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = listAdminOrdersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const result = await listAdminOrders(parseResult.data);

    sendSuccess(res, 200, result);
  }
);


// GET /api/admin/orders/:orderId
// Auth: requireAdmin (applied at router mount in app.ts)
// Full order detail — customer, payment, shipping, shipment, webhook history.

const adminOrderDetailParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const getAdminOrderDetailHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = adminOrderDetailParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    const detail = await getAdminOrderDetail(parseResult.data.orderId);

    sendSuccess(res, 200, detail);
  }
);


// POST /api/admin/orders/:orderId/confirm-dimensions
// Auth: requireAdmin (applied at router mount in app.ts)
// Body: { length, breadth, height, weight } — validated via validateBody
//       middleware in the route file.
//
// This triggers Phase B of the Shiprocket flow inline (~3–5s):
//   updateOrder (push real dims) → assignAwb → generatePickup.
//
// Preconditions the service enforces (all throw ConflictError → 409):
//   - Order.status === "READY_TO_SHIP"
//   - Order.shiprocketOrderId AND shiprocketShipmentId set (Phase A ran)
//   - Order.awbNumber is null (Phase B has NOT already run)
//
// On success returns AWB, courier name, and pickup schedule so the admin
// panel can immediately show what happened.

const confirmDimensionsParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const confirmDimensionsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const paramsResult = confirmDimensionsParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      throw new ValidationError(
        paramsResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    // Body already validated by validateBody(confirmDimensionsBodySchema)
    // middleware — we can trust its shape here.
    const { length, breadth, height, weight } = req.body as {
      length: number;
      breadth: number;
      height: number;
      weight: number;
    };

    const result = await pushDimensionsAssignAwbAndSchedulePickup(
      paramsResult.data.orderId,
      { length, breadth, height, weight }
    );

    sendSuccess(res, 200, result, "Dimensions confirmed; AWB assigned and pickup scheduled");
  }
);


// POST /api/admin/orders/:orderId/retry-shiprocket
// Auth: requireAdmin (applied at router mount in app.ts)
//
// Retries Phase A for an order stuck at SHIPROCKET_FAILED. Handles both
// clean-retry (no Shiprocket IDs) and recovery (Shiprocket IDs present but
// DB stuck) paths — see retryPhaseAForFailedOrder for details.
//
// Response `recovered: true` means we skipped the Shiprocket call because
// the order already existed on their side — useful for admin logs.

const retryShiprocketParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const retryShiprocketHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = retryShiprocketParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    const result = await retryPhaseAForFailedOrder(parseResult.data.orderId);

    sendSuccess(
      res,
      200,
      result,
      result.recovered
        ? "Order recovered — Shiprocket already had this shipment, DB reconciled"
        : "Shiprocket retry succeeded — order is ready to ship"
    );
  }
);


// GET /api/admin/orders/:orderId/label
// Auth: requireAdmin (applied at router mount in app.ts)
//
// Returns a FRESH label PDF URL from Shiprocket every call — never cached
// on our side per DECISIONS. Admin frontend either opens the URL in a new
// tab or triggers download.
//
// Preconditions enforced in the service (all 409):
//   status ∈ {READY_TO_SHIP, SHIPPED, DELIVERED}, shiprocketShipmentId
//   set, awbNumber set.

const labelParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const getOrderLabelHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = labelParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    const result = await getLabelForOrder(parseResult.data.orderId);

    sendSuccess(res, 200, result);
  }
);

// POST /api/admin/orders/:orderId/refresh-tracking
// Auth: requireAdmin (applied at router mount in app.ts)
//
// Manual tracking refresh — hits Shiprocket's track-by-AWB endpoint and
// reconciles the fresh data into our DB (first-write-wins on lifecycle
// timestamps, forward-only on status transitions).
//
// Response includes the raw Shiprocket payload AND a summary of what
// actually changed in our DB, so admin can see both.

const refreshTrackingParamsSchema = z.object({
  orderId: z.string().uuid("Invalid order ID format"),
});

export const refreshTrackingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = refreshTrackingParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid order ID"
      );
    }

    const result = await refreshTrackingForOrder(parseResult.data.orderId);

    sendSuccess(res, 200, result);
  }
);