import { Router } from "express";
import { razorpayWebhookHandler, shiprocketWebhookHandler, } from "../controllers/webhook.controller.js";

const router = Router();

router.post("/razorpay", razorpayWebhookHandler);

// Shiprocket tracking webhook. Shiprocket's dashboard refuses webhook URLs
// containing "shiprocket", "kartrocket", "sr" or "kr", so the URL registered
// there is /api/webhooks/tracking. /shiprocket stays as an alias for anything
// already pointing at it; both run the same handler.
router.post("/tracking", shiprocketWebhookHandler);
router.post("/shiprocket", shiprocketWebhookHandler);

export default router;
