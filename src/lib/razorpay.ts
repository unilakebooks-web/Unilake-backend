import Razorpay from "razorpay";
import { config } from "../config/env.js";
import { logger } from "./logger.js";
import crypto from "crypto";

/**
 * Verifies the HMAC-SHA256 signature Razorpay attaches to every webhook.
 *
 * @param rawBody       The exact bytes of the request body. MUST be the raw Buffer/string
 *                      as received on the wire — parsing to JSON changes byte-for-byte
 *                      content and breaks the signature match.
 * @param signature     Value of the `x-razorpay-signature` request header.
 * @returns             true if the signature matches; false otherwise.
 */

export const razorpay = new Razorpay({
  key_id: config.razorpay.razorpayKeyId,
  key_secret: config.razorpay.razorpayKeySecret,
});

logger.info(
  { keyIdPrefix: config.razorpay.razorpayKeyId.slice(0, 12) },
  "Razorpay client initialized"
);

/**
 * Currencies with no minor unit. Razorpay expects the amount in the smallest unit,
 * which for these currencies is the same as the major unit (no multiplication).
 * Reference: ISO 4217 currencies where the minor unit is zero.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY", // Japanese Yen
  "KRW", // South Korean Won
  "VND", // Vietnamese Dong
  "CLP", // Chilean Peso
  "ISK", // Icelandic Krona
  "TWD", // Taiwan Dollar (Razorpay treats as zero-decimal)
]);

/**
 * Currencies with three decimal places (rare).
 * Multiplier is 1000 for these.
 */
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", // Bahraini Dinar
  "KWD", // Kuwaiti Dinar
  "OMR", // Omani Rial
  "JOD", // Jordanian Dinar
]);

/**
 * Convert a major-unit amount (e.g. 999.50 USD) into the smallest unit
 * that Razorpay expects (e.g. 99950 cents).
 *
 * Always pass amount as a number of major units. Currency is ISO 4217 alpha-3.
 *
 * INR 999.50  -> 99950 paise
 * USD 999.50  -> 99950 cents
 * JPY 1000    -> 1000 yen (no multiplier)
 * KWD 10.500  -> 10500 fils
 */

export function toSmallestUnit(amount: number, currency: string): number {
  const upperCurrency = currency.toUpperCase();

  let multiplier: number;
  if (ZERO_DECIMAL_CURRENCIES.has(upperCurrency)) {
    multiplier = 1;
  } else if (THREE_DECIMAL_CURRENCIES.has(upperCurrency)) {
    multiplier = 1000;
  } else {
    multiplier = 100; // default: 2 decimal places (INR, USD, EUR, GBP, most others)
  }

  // Multiply then round to avoid floating-point tails like 99950.00000001
  const smallest = Math.round(amount * multiplier);

  if (!Number.isFinite(smallest) || smallest < 0) {
    throw new Error(
      `Invalid amount conversion: ${amount} ${currency} -> ${smallest}`
    );
  }
  return smallest;
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  try {
    const expected = crypto
      .createHmac("sha256", config.razorpay.razorpayWebhookSecret)
      .update(rawBody)
      .digest("hex");

    // Timing-safe comparison — prevents timing-attack signature guessing.
    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(signature, "hex");

    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (error) {
    logger.error({ error }, "Webhook signature verification threw");
    return false;
  }
}
