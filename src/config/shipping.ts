// Placeholder package dimensions used when creating the Shiprocket order at
// send-to-print time. Real dimensions come from the admin at packaging before
// generating the awb number we will call the siprocket update order api, which updates the
// Shiprocket order before AWB assignment. See section 4 in the Shiprocket
// integration plan for the two-stage flow rationale.
export const DEFAULT_PACKAGE_LENGTH_CM = 25;
export const DEFAULT_PACKAGE_BREADTH_CM = 20;
export const DEFAULT_PACKAGE_HEIGHT_CM = 1;
export const DEFAULT_PACKAGE_WEIGHT_KG = 0.25;

// Bounds for admin-entered final dimensions. Shiprocket rejects zero/negative
// values silently; a max cap keeps typos (e.g. entering weight in grams as 250
// instead of 0.25) from creating unshippable orders.
export const MIN_DIMENSION_CM = 0.5;
export const MAX_DIMENSION_CM = 200;
export const MIN_WEIGHT_KG = 0.05;
export const MAX_WEIGHT_KG = 30;

// HSN code for printed books (India customs classification). Not used for
// domestic shipments — kept here for the international branch that gets added
// later. See DECISIONS.md if/when international is enabled.
export const HSN_CODE_PRINTED_BOOK = "4901";

// Shiprocket status string → internal OrderStatus enum. Shiprocket sends the
// raw string in webhooks; we store it verbatim in `trackingStatus` (audit trail)
// AND flip `Order.status` per this mapping. Any status not in this map is stored
// but does NOT change Order.status — safe default, no accidental state changes.
import type { OrderStatus } from "../generated/prisma/client.js";

export const SHIPROCKET_STATUS_MAP: Record<string, OrderStatus> = {
  // Sent / picked up → SHIPPED
  "PICKED UP": "SHIPPED",
  "IN TRANSIT": "SHIPPED",
  "OUT FOR DELIVERY": "SHIPPED",
  // Terminal success
  DELIVERED: "DELIVERED",
  // Failure branches
  CANCELED: "SHIPROCKET_FAILED",
  CANCELLED: "SHIPROCKET_FAILED",
  RTO: "SHIPROCKET_FAILED",
  "RTO INITIATED": "SHIPROCKET_FAILED",
  "RTO DELIVERED": "SHIPROCKET_FAILED",
  LOST: "SHIPROCKET_FAILED",
};

// ⚠️⚠️ DO NOT IMPORT ANYTHING BELOW THIS LINE — DUPLICATE, AND IT IS THE WRONG
//        ONE. (flagged Sep 21, 2026)
//
// `PublicOrderStatusCode`, `PublicOrderStatus` and `toPublicStatus` are ALSO
// defined in `src/utils/orderStatusMapping.ts`. That file is the canonical
// copy — it is what `order.service.ts` imports, and it is what customers
// actually see today.
//
// The two copies DISAGREE. Same input, different output:
//
//   status      | orderStatusMapping.ts (correct)     | this file (wrong)
//   ------------|------------------------------------|---------------------------
//   GENERATED   | AWAITING_SELECTION                 | PREPARING
//               | "Awaiting your selection"          | "Preparing your book"
//   PAID        | "Comic being created"              | "Preparing your book"
//   CONFIRMED   | "Printing"                         | "Getting ready to ship"
//
// The GENERATED row is the one that matters. It means every paid page is done
// and the book is waiting on the CUSTOMER to pick variants and send to print —
// nothing is happening server-side. The canonical copy gives it its own code so
// the UI can prompt them. This copy collapses it into PREPARING, which tells the
// customer to sit tight and wait for us. That is the opposite instruction, and
// an order in that state would never move.
//
// NOTHING IS BROKEN RIGHT NOW: only `order.service.ts` calls this function and
// it imports the correct copy, so everything below is dead code. The danger is
// the next call site. Someone working on shipping opens this file, finds
// `toPublicStatus` sitting right here, and imports it. It typechecks, it boots,
// it returns a valid-looking object — and customers silently get wrong wording
// with nothing anywhere reporting a problem.
//
// This is the same failure shape as the `assertNotExpired` duplication that
// reached production on Aug 22: two copies of one function, quietly disagreeing,
// and which one you got depended on which file you imported from.
//
// FIX: delete this whole block (the two types + the function). Nothing imports
// it. Left in place for now only because removing it was outside the scope of
// the change that found it.
//
// ============================================================
// PUBLIC ORDER STATUS — internal enum → customer-facing shape
// ============================================================
//
// The customer-facing tracking endpoint (Section 6) never exposes the raw
// OrderStatus enum or the raw Shiprocket `trackingStatus` string. Both are
// admin-only. Instead, we return { code, label }:
//   - `code` is a stable machine-readable string the frontend switches on.
//   - `label` is the human string shown to the customer.
//
// Deliberate collapses:
//   - PAID and GENERATED both show "Preparing your book" — the customer
//     doesn't care which internal stage we're in.
//   - CONFIRMED, READY_TO_SHIP, and SHIPROCKET_FAILED all show
//     "Getting ready to ship". Backend failure is admin's problem, not
//     the customer's — they see the same neutral message while admin
//     recovers via the SHIPROCKET_FAILED queue (Section 7).
//
// The switch is deliberately exhaustive: adding a new OrderStatus value
// without updating this function will fail typecheck.

export type PublicOrderStatusCode =
  | "AWAITING_PAYMENT"
  | "PREPARING"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export type PublicOrderStatus = {
  code: PublicOrderStatusCode;
  label: string;
};

export function toPublicStatus(status: OrderStatus): PublicOrderStatus {
  switch (status) {
    case "CREATED":
      return { code: "AWAITING_PAYMENT", label: "Awaiting payment" };
    case "PAID":
    case "GENERATED":
      return { code: "PREPARING", label: "Preparing your book" };
    case "CONFIRMED":
    case "READY_TO_SHIP":
    case "SHIPROCKET_FAILED":
      return { code: "PROCESSING", label: "Getting ready to ship" };
    case "SHIPPED":
      return { code: "SHIPPED", label: "On the way" };
    case "DELIVERED":
      return { code: "DELIVERED", label: "Delivered" };
    case "CANCELLED":
      return { code: "CANCELLED", label: "Cancelled" };
  }
}