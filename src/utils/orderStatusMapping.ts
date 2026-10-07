import type { OrderStatus } from "../generated/prisma/client.js";

/**
 * Customer-facing order status.
 *
 * We collapse the 9 internal states into 7 stages the customer sees on their
 * "My Orders" page. Rationale:
 *  - Internal states like SHIPROCKET_FAILED are ops concerns, not customer concerns.
 *  - CONFIRMED / SHIPROCKET_FAILED / READY_TO_SHIP all mean the same thing to the
 *    user: "we're preparing your book."
 *  - Renaming a public stage should never require a schema migration; it's just
 *    a one-line change in this file.
 *
 * Each stage carries BOTH a stable `code` and a display `label`. The split is
 * load-bearing: clients branch and pick pill colours on `code`, and show
 * `label`. Sending the label alone would force the UI to switch on display
 * copy, so renaming a stage would silently break styling and conditionals —
 * exactly the coupling the third bullet above exists to prevent.
 */

export type PublicOrderStatusCode =
  | "AWAITING_PAYMENT"
  | "PREPARING"
  | "AWAITING_SELECTION"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export interface PublicOrderStatus {
  code: PublicOrderStatusCode;
  label: string;
}

const MAPPING: Record<OrderStatus, PublicOrderStatus> = {
  CREATED: { code: "AWAITING_PAYMENT", label: "Awaiting payment" },
  PAID: { code: "PREPARING", label: "Comic being created" },
  // The customer's move: every paid page is generated and the book is waiting
  // on them to pick variants and send it to print. Nothing is happening
  // server-side in this state, which is why it needs its own code — the UI has
  // to be able to prompt them rather than imply we are still working.
  GENERATED: { code: "AWAITING_SELECTION", label: "Awaiting your selection" },
  CONFIRMED: { code: "PROCESSING", label: "Printing" },
  SHIPROCKET_FAILED: { code: "PROCESSING", label: "Printing" },
  READY_TO_SHIP: { code: "PROCESSING", label: "Printing" },
  SHIPPED: { code: "SHIPPED", label: "Shipped" },
  DELIVERED: { code: "DELIVERED", label: "Delivered" },
  CANCELLED: { code: "CANCELLED", label: "Cancelled" },
};

export function toPublicStatus(status: OrderStatus): PublicOrderStatus {
  return MAPPING[status];
}
