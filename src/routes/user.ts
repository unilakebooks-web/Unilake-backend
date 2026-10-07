import { Router } from "express";
import { validateBody } from "../middlewares/validateBody.js";
import {
  createAddressSchema,
  updateAddressSchema,
} from "../validators/savedAddress.schema.js";
import {
  listAddressesHandler,
  createAddressHandler,
  updateAddressHandler,
  deleteAddressHandler,
  setDefaultAddressHandler,
} from "../controllers/savedAddress.controller.js";
import {
  listUserOrdersHandler,
  getUserOrderHandler,
  getUserOrderTrackingHandler,
} from "../controllers/order.controller.js";

import { sendToPrintHandler } from "../controllers/session.controller.js";

const router = Router();

// Saved addresses
router.get("/addresses", listAddressesHandler);
router.post("/addresses", validateBody(createAddressSchema), createAddressHandler);
router.patch("/addresses/:id", validateBody(updateAddressSchema), updateAddressHandler);
router.delete("/addresses/:id", deleteAddressHandler);
router.post("/addresses/:id/set-default", setDefaultAddressHandler);

// Orders — customer-facing view of their own orders
router.get("/orders", listUserOrdersHandler);
router.get("/orders/:id", getUserOrderHandler);

// Section 6 — user tracking. Separate path (three segments) so no conflict
// with /orders/:id. Response shape lives in order.service.ts::UserOrderTracking.
router.get("/orders/:orderId/tracking", getUserOrderTrackingHandler);

// Send-to-print — customer commits variant selections, session locks,
// PDF compilation kicks off. Idempotent: safe to re-hit.
router.post("/sessions/:sessionId/send-to-print", sendToPrintHandler);

export default router;