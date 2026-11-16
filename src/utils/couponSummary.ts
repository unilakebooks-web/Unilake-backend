import type { Prisma } from "../generated/prisma/client.js";

/**
 * What the customer sees about the coupon on an order: the shape returned in
 * the session response so a returning customer sees what is applied. Pure; the
 * amounts are decimal strings like every other money value in the API.
 */
export function couponSummary(
  order: {
    couponCode: string | null;
    discountAmount: Prisma.Decimal;
    listAmount: Prisma.Decimal | null;
    amount: Prisma.Decimal;
    currency: string;
    couponRedemption: { coupon: { name: string } } | null;
  } | null
) {
  if (!order?.couponCode) return null;

  return {
    code: order.couponCode,
    name: order.couponRedemption?.coupon.name ?? null,
    listAmount: order.listAmount?.toString() ?? null,
    discountAmount: order.discountAmount.toString(),
    finalAmount: order.amount.toString(),
    currency: order.currency,
  };
}
