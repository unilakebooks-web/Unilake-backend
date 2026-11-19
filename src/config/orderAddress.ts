import type {
  AddressSyncStatus,
  OrderStatus,
} from "../generated/prisma/client.js";

// Admin changes to an order's delivery address (see orderAddress.service.ts).

// Order statuses in which the address may still be changed. Also needs
// awbNumber to be empty: the AWB is what locks the address.
export const ADDRESS_EDITABLE_STATUSES: OrderStatus[] = [
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
];

// Statuses in which a Shiprocket order exists, is being created, or can be
// created at any moment (createShipmentForSession runs after send-to-print,
// which makes the order CONFIRMED). A change made here must be pushed, so its
// history row starts as PENDING. In PAID and GENERATED nothing can be running,
// and the later shipment is built from the saved address.
export const ADDRESS_PUSH_RELEVANT_STATUSES: OrderStatus[] = [
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
];

// ⚠️ Mirrored by OPEN in unilake-frontend components/admin/order/AddressHistory.tsx, and the
// AddressSyncStatus enum is also written out in that file and in app/types/order.ts.
// While any change of an order is in one of these states, Shiprocket may still
// hold the old address, so "Generate AWB" is refused.
export const ADDRESS_SYNC_BLOCKING_STATUSES: AddressSyncStatus[] = [
  "PENDING",
  "SYNCING",
  "FAILED",
  "UNVERIFIED",
];

// A SYNCING claim older than this is treated as abandoned (the process that made
// it died), so it can be retried. Longer than the slowest sync can take (a first read,
// a push and three read-backs, each with a 15 second timeout, is about 80 seconds).
export const ADDRESS_SYNC_CLAIM_STALE_MS = 5 * 60 * 1000;

// After Shiprocket accepts a change (202, no body) the order is read back up to
// this many times, this far apart, until it shows the new address.
export const ADDRESS_READBACK_ATTEMPTS = 3;
export const ADDRESS_READBACK_DELAY_MS = 2000;
