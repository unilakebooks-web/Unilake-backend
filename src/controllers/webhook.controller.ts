import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logger } from "../lib/logger.js";
import {
  handleRazorpayWebhook,
  handleShiprocketWebhook,
  WebhookVerificationError,
} from "../services/webhook.service.js";


export const razorpayWebhookHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // express.raw() puts a Buffer here
    const rawBody = req.body as Buffer;
    const signature = req.header("x-razorpay-signature");
    // Razorpay's own event identifier — unique per event, stable across its
    // retries of that event. This is the idempotency key; see webhook.service.ts.
    const eventId = req.header("x-razorpay-event-id");

    try {
      await handleRazorpayWebhook(rawBody, signature, eventId);
      // Always 200 on success — signals Razorpay to stop retrying.
      res.status(200).json({ received: true });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        logger.warn(
          { message: error.message },
          "Razorpay webhook verification failed"
        );
        // 400 tells Razorpay to stop retrying (permanent failure, not transient).
        res.status(400).json({ error: error.message });
        return;
      }
      // Any other error is unexpected — let Express error handler take it.
      // Razorpay will retry, which is what we want on transient failures.
      throw error;
    }
  }
);

export const shiprocketWebhookHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // express.raw() puts a Buffer here — same as razorpay.
    const rawBody = req.body as Buffer;
    // Shiprocket sends the shared secret in x-api-key (per our webhook
    // dashboard config: Auth Token Type = x-api-key).
    const providedToken = req.header("x-api-key");

    try {
      await handleShiprocketWebhook(rawBody, providedToken);
      // 200 acks the webhook — Shiprocket stops retrying this event.
      res.status(200).json({ received: true });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        logger.warn(
          { message: error.message },
          "Shiprocket webhook verification failed"
        );
        // 400 = permanent, Shiprocket should not retry.
        res.status(400).json({ error: error.message });
        return;
      }
      // Anything else = transient. Let Shiprocket retry.
      throw error;
    }
  }
);