import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";
import {
  getOrderAddress,
  updateOrderAddress,
  type ShiprocketOrderAddress,
} from "../lib/shiprocket.js";
import {
  ADDRESS_EDITABLE_STATUSES,
  ADDRESS_PUSH_RELEVANT_STATUSES,
  ADDRESS_SYNC_BLOCKING_STATUSES,
  ADDRESS_SYNC_CLAIM_STALE_MS,
  ADDRESS_READBACK_ATTEMPTS,
  ADDRESS_READBACK_DELAY_MS,
} from "../config/orderAddress.js";
import type {
  AddressSyncStatus,
  OrderStatus,
  Prisma,
} from "../generated/prisma/client.js";

// ============================================================
// ADMIN CHANGES AN ORDER'S DELIVERY ADDRESS
// ============================================================
//
// The Order's shipping fields are the source of truth once the order exists
// (Shiprocket, the bill, the admin and customer order views all read them), so
// an edit writes them, and the session's copy too, so nobody reads a stale one.
// Every edit leaves a row in order_address_changes: old value, new value, who,
// when, and whether Shiprocket has the new one.
//
// Rules this file keeps (do not loosen them):
//   - One transaction per edit, under a per-order advisory lock, with a guarded
//     write (awbNumber still empty, status still what was read). No Shiprocket
//     call inside a transaction.
//   - The AWB locks the address. Until then it may change, in the statuses in
//     config/orderAddress.ts.
//   - A change made while a Shiprocket order exists, or may be created any
//     moment, is PENDING until Shiprocket is confirmed to hold it. Phase B
//     (generate AWB) is refused while one is PENDING, SYNCING, FAILED or
//     UNVERIFIED, so a parcel is never booked against a stale address.
//   - Syncing is per ORDER: one at a time, always the CURRENT Order address,
//     covering the history rows up to the highest seq it saw. An older address
//     can therefore never be pushed after a newer one.
//   - Shiprocket answers 202 with no body, so a push is always followed by a
//     read of the order. Only a matching read is SYNCED. The phone is masked in
//     that read, so it is pushed but cannot be compared.

type ShippingAddress = {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
};

type EditOrderAddressInput = {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  phone: string;
  /**
   * The newest change the admin's form was based on. The route's validator always requires
   * it; it is optional here only so tests and scripts that call the service directly can leave
   * the stale-form check out on purpose.
   */
  expectedSeq?: number;
};

type AddressActor = { id: string; email: string };

// ⚠️ The frontend (AddressHistory.tsx) recognises this text by its start.
const AWB_DURING_CHANGE_MESSAGE =
  "The AWB was created while this change was being made. Check that the label shows this address.";
const PUSH_FAILED_MESSAGE = "Shiprocket did not accept the new address";
const NOT_APPLIED_MESSAGE = "Shiprocket has not applied the change yet";
// A phone is masked in Shiprocket's reply, so a SYNCED change of the phone is "sent", not "confirmed".
const PHONE_NOT_CONFIRMED_NOTE =
  "The phone was sent to Shiprocket; it cannot be read back there (Shiprocket masks it), so it is not confirmed.";
const UNEXPECTED_MESSAGE = "The address could not be synced";

// Reads of the order before the guarded write: one re-read when the status moved in between.
const EDIT_READ_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Tx = Prisma.TransactionClient;

// One lock per order for every edit, sync claim and manual mark (the pattern of the
// role-change lock in user.service.ts), so two of them can never interleave.
async function lockOrderAddress(tx: Tx, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-address:${orderId}`}))`;
}

// A SYNCING claim younger than ADDRESS_SYNC_CLAIM_STALE_MS is a sync that is running now.
async function assertNoSyncInProgress(tx: Tx, orderId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - ADDRESS_SYNC_CLAIM_STALE_MS);
  const running = await tx.orderAddressChange.count({
    where: {
      orderId,
      syncStatus: "SYNCING",
      syncStartedAt: { gt: staleBefore },
    },
  });
  if (running > 0) {
    throw new ConflictError(
      "An address sync is already in progress for this order"
    );
  }
}

// The changes a sync or a manual mark may take: not yet confirmed, or claimed so
// long ago that the claim is abandoned.
// ⚠️ ADDRESS_SYNC_BLOCKING_STATUSES (config/orderAddress.ts) is wider on purpose: it
// also holds every SYNCING row, because Generate AWB must wait for a running sync too.
// The frontend list of open states (AddressHistory.tsx, OPEN) follows the blocking set.
function unsyncedWhere(orderId: string): Prisma.OrderAddressChangeWhereInput {
  const staleBefore = new Date(Date.now() - ADDRESS_SYNC_CLAIM_STALE_MS);
  return {
    orderId,
    OR: [
      { syncStatus: { in: ["PENDING", "FAILED", "UNVERIFIED"] } },
      { syncStatus: "SYNCING", syncStartedAt: { lte: staleBefore } },
    ],
  };
}

type OrderAddressFields = {
  shippingName: string | null;
  shippingLine1: string | null;
  shippingLine2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
};

const ORDER_ADDRESS_SELECT = {
  shippingName: true,
  shippingLine1: true,
  shippingLine2: true,
  shippingCity: true,
  shippingState: true,
  shippingZip: true,
  shippingCountry: true,
  shippingPhone: true,
} as const;

function addressOf(order: OrderAddressFields): ShippingAddress {
  return {
    name: order.shippingName,
    line1: order.shippingLine1,
    line2: order.shippingLine2,
    city: order.shippingCity,
    state: order.shippingState,
    zip: order.shippingZip,
    country: order.shippingCountry,
    phone: order.shippingPhone,
  };
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function sameText(a: string | null | undefined, b: string | null | undefined) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

// Does Shiprocket hold this address? Compares what the read can show: name,
// both address lines, city, state and pincode. The country is not editable and
// the phone is masked by Shiprocket, so neither is compared (a phone change is
// therefore always pushed: see phoneChanged in the claim).
// ignoreCase: false before a push (a correction of capitalisation alone must be
// pushed); true after it, so a Shiprocket that normalises case does not turn a
// delivered change into a permanent mismatch.
function shiprocketHolds(
  wanted: ShippingAddress,
  held: ShiprocketOrderAddress,
  opts: { ignoreCase: boolean }
): boolean {
  const same = opts.ignoreCase
    ? sameText
    : (a: string | null | undefined, b: string | null | undefined) =>
        norm(a) === norm(b);
  return (
    same(wanted.name, held.name) &&
    same(wanted.line1, held.line1) &&
    same(wanted.line2, held.line2) &&
    same(wanted.city, held.city) &&
    same(wanted.state, held.state) &&
    norm(wanted.zip) === norm(held.pincode)
  );
}

function isBlankRead(held: ShiprocketOrderAddress): boolean {
  return !held.name && !held.line1 && !held.city && !held.pincode;
}

// ============================================================
// MAY THE ADDRESS CHANGE?
// ============================================================

// What the admin order page shows. The edit itself checks the same rule from the row
// it reads under the lock, and its guarded write only confirms that the status and
// the empty awbNumber it read are still true.
export function getAddressEditState(order: {
  status: OrderStatus;
  awbNumber: string | null;
}): { editable: boolean; reason: string | null } {
  if (order.awbNumber) {
    return {
      editable: false,
      reason: "The AWB is already generated, so the address is locked",
    };
  }
  if (order.status === "CREATED") {
    return { editable: false, reason: "This order is not paid yet" };
  }
  if (order.status === "CANCELLED") {
    return { editable: false, reason: "This order is cancelled" };
  }
  if (!ADDRESS_EDITABLE_STATUSES.includes(order.status)) {
    return { editable: false, reason: "This order has already shipped" };
  }
  return { editable: true, reason: null };
}

// ============================================================
// EDIT
// ============================================================

export async function editOrderAddress(
  orderId: string,
  input: EditOrderAddressInput,
  actor: AddressActor
) {
  const next = {
    name: input.name.trim(),
    line1: input.line1.trim(),
    line2: input.line2?.trim() ? input.line2.trim() : null,
    city: input.city.trim(),
    state: input.state.trim(),
    zip: input.zip.trim(),
    phone: input.phone.trim(),
  };

  const created = await prisma.$transaction(async (tx) => {
    await lockOrderAddress(tx, orderId);

    // The guarded write below matches on the status that was read. If the status
    // moves between the read and the write (send-to-print does that), read again
    // once; a second miss is reported instead of looping.
    for (let attempt = 1; attempt <= EDIT_READ_ATTEMPTS; attempt++) {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderSessionId: true,
          status: true,
          awbNumber: true,
          shiprocketOrderId: true,
          ...ORDER_ADDRESS_SELECT,
        },
      });
      if (!order) {
        throw new NotFoundError("Order not found");
      }

      const state = getAddressEditState(order);
      if (!state.editable) {
        throw new ConflictError(
          state.reason ?? "The address cannot be changed"
        );
      }

      // The form must have been filled in from the newest change: a save on top of a newer
      // one would put back whatever the other admin had just fixed.
      if (input.expectedSeq !== undefined) {
        const latest = await tx.orderAddressChange.findFirst({
          where: { orderId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        if ((latest?.seq ?? 0) > input.expectedSeq) {
          throw new ConflictError(
            "The address was changed by someone else after you opened this. Reload the order and check it before saving."
          );
        }
      }

      // ⚠️ The same two rules are in unilake-frontend components/admin/order/addressEditSchema.ts.
      // Refused up front, not at AWB time: a value Shiprocket or our own
      // shipment code would reject.
      if (order.shippingCountry === "IN" && !/^[1-9]\d{5}$/.test(next.zip)) {
        throw new ValidationError("An Indian pincode has 6 digits");
      }
      // Shiprocket takes the phone as a number: a leading 0 would be dropped, and an
      // Indian order needs exactly 10 digits. Checked in every editable status: the
      // address reaches Shiprocket sooner or later (at the push, or when the shipment
      // is made from the saved address).
      if (next.phone.startsWith("0")) {
        throw new ValidationError("The phone number cannot start with 0");
      }
      if (order.shippingCountry === "IN" && !/^\d{10}$/.test(next.phone)) {
        throw new ValidationError(
          "An Indian order needs a 10-digit phone number"
        );
      }

      const before = addressOf(order);
      const after: ShippingAddress = {
        name: next.name,
        line1: next.line1,
        line2: next.line2,
        city: next.city,
        state: next.state,
        zip: next.zip,
        country: before.country, // not editable
        phone: next.phone,
      };

      // Case counts here: correcting only the capitalisation ("pune" to "Pune") is a
      // change. Spacing does not count. (The Shiprocket comparison ignores case.)
      const unchanged =
        norm(before.name) === norm(after.name) &&
        norm(before.line1) === norm(after.line1) &&
        norm(before.line2) === norm(after.line2) &&
        norm(before.city) === norm(after.city) &&
        norm(before.state) === norm(after.state) &&
        norm(before.zip) === norm(after.zip) &&
        norm(before.phone) === norm(after.phone);
      if (unchanged) {
        return null;
      }

      const { count } = await tx.order.updateMany({
        where: { id: orderId, awbNumber: null, status: order.status },
        data: {
          shippingName: after.name,
          shippingLine1: after.line1,
          shippingLine2: after.line2,
          shippingCity: after.city,
          shippingState: after.state,
          shippingZip: after.zip,
          shippingPhone: after.phone,
        },
      });
      if (count === 0) {
        continue;
      }

      // The session keeps its own copy of the address (the public session
      // response returns it). Update it too so nobody reads a stale one. This
      // deliberately bypasses the customer-side field lock.
      await tx.orderSession.update({
        where: { id: order.orderSessionId },
        data: {
          shippingName: after.name,
          shippingLine1: after.line1,
          shippingLine2: after.line2,
          shippingCity: after.city,
          shippingState: after.state,
          shippingZip: after.zip,
          shippingPhone: after.phone,
        },
      });

      const syncStatus: AddressSyncStatus =
        ADDRESS_PUSH_RELEVANT_STATUSES.includes(order.status)
          ? "PENDING"
          : "NOT_REQUIRED";

      const row = await tx.orderAddressChange.create({
        data: {
          orderId,
          before: before as Prisma.InputJsonValue,
          after: after as Prisma.InputJsonValue,
          changedById: actor.id,
          changedByEmail: actor.email,
          syncStatus,
        },
        select: { id: true, seq: true, syncStatus: true },
      });

      return { ...row, hasShiprocketOrder: !!order.shiprocketOrderId };
    }

    throw new ConflictError(
      "The order changed while the address was being saved. Reload the page and try again."
    );
  });

  if (!created) {
    // Nothing differs, but an earlier change may still be waiting for Shiprocket: say so,
    // so "nothing was changed" does not hide it.
    const waiting = await prisma.orderAddressChange.count({
      where: {
        orderId,
        // A sync that is running right now is not "waiting" (a double click would otherwise
        // be told that the change it just made is waiting).
        syncStatus: { in: ["PENDING", "FAILED", "UNVERIFIED"] },
        order: { awbNumber: null },
      },
    });
    return { changed: false as const, unsynced: waiting > 0 };
  }

  logger.info(
    { orderId, changeId: created.id, seq: created.seq, adminId: actor.id },
    "Order address changed"
  );

  // A PENDING change on an order Shiprocket already holds is pushed now. With
  // no Shiprocket order yet it waits; Phase B stays refused until it is synced.
  let syncStatus: AddressSyncStatus = created.syncStatus;
  if (created.syncStatus === "PENDING" && created.hasShiprocketOrder) {
    try {
      syncStatus = (await syncOrderAddress(orderId, actor)).status;
    } catch (error) {
      // The change is saved, so the admin is never answered with an error for it. A
      // sync that could not start (another one is running, or the AWB appeared
      // meanwhile) leaves it PENDING; anything else is logged and the row's real
      // state is shown, where Retry sync can pick it up.
      if (error instanceof ConflictError) {
        logger.info(
          { orderId, changeId: created.id, reason: error.message },
          "Address change saved; sync did not start"
        );
      } else {
        logger.error(
          { err: error, orderId, changeId: created.id },
          "Address change saved; sync failed unexpectedly"
        );
      }
      const row = await prisma.orderAddressChange
        .findUnique({ where: { id: created.id }, select: { syncStatus: true } })
        .catch(() => null);
      syncStatus = row?.syncStatus ?? created.syncStatus;
    }
  }

  return {
    changed: true as const,
    changeId: created.id,
    seq: created.seq,
    syncStatus,
  };
}

// ============================================================
// SYNC WITH SHIPROCKET (one per order, current address)
// ============================================================

type SyncClaim = {
  coveredIds: string[];
  // The claim's own time: the final write matches it, so a sync that was taken over
  // after going stale cannot overwrite the claim that replaced it.
  startedAt: Date;
  // A phone is masked in the Shiprocket read, so "Shiprocket already holds it" can
  // never be proven for a phone: a covered change of the phone is always pushed.
  phoneChanged: boolean;
  address: ShippingAddress;
  shiprocketOrderId: string;
};

async function claimSync(orderId: string): Promise<SyncClaim> {
  return prisma.$transaction(async (tx) => {
    await lockOrderAddress(tx, orderId);

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        awbNumber: true,
        shiprocketOrderId: true,
        ...ORDER_ADDRESS_SELECT,
      },
    });
    if (!order) {
      throw new NotFoundError("Order not found");
    }
    if (order.awbNumber) {
      throw new ConflictError(
        "The AWB is already generated, so the address is locked"
      );
    }
    if (!order.shiprocketOrderId) {
      throw new ConflictError(
        "The Shiprocket order has not been created yet. Try again when the order shows Ready to ship."
      );
    }

    await assertNoSyncInProgress(tx, orderId);

    const rows = await tx.orderAddressChange.findMany({
      where: unsyncedWhere(orderId),
      select: { id: true, before: true, after: true },
    });
    if (rows.length === 0) {
      throw new ConflictError(
        "There is no address change waiting to be synced"
      );
    }

    const coveredIds = rows.map((r) => r.id);
    const startedAt = new Date();
    const phoneChanged = rows.some(
      (r) =>
        norm((r.before as ShippingAddress).phone) !==
        norm((r.after as ShippingAddress).phone)
    );
    await tx.orderAddressChange.updateMany({
      where: { id: { in: coveredIds } },
      data: {
        syncStatus: "SYNCING",
        syncStartedAt: startedAt,
        syncError: null,
      },
    });

    return {
      coveredIds,
      startedAt,
      phoneChanged,
      address: addressOf(order),
      shiprocketOrderId: order.shiprocketOrderId,
    };
  });
}

type SyncOutcome = {
  status: "SYNCED" | "FAILED" | "UNVERIFIED";
  error: string | null;
};

async function countryNameFor(code: string | null): Promise<string> {
  if (!code) return "";
  const country = await prisma.country.findUnique({
    where: { code },
    select: { name: true },
  });
  return country?.name ?? "";
}

// Reads first (the change may already be there, for instance when the Shiprocket
// order was created after the edit), pushes only if Shiprocket differs, then reads
// back. Never throws: every failure becomes an outcome the history row records.
async function pushAndConfirm(
  claim: SyncClaim,
  orderId: string
): Promise<SyncOutcome> {
  const { address, shiprocketOrderId } = claim;

  let held: ShiprocketOrderAddress | null = null;
  try {
    held = await getOrderAddress(shiprocketOrderId);
  } catch (err) {
    logger.warn(
      { err, orderId },
      "Address sync: first read of the Shiprocket order failed"
    );
  }
  if (
    held &&
    !claim.phoneChanged &&
    shiprocketHolds(address, held, { ignoreCase: false })
  ) {
    return { status: "SYNCED", error: null };
  }

  // Shiprocket takes the phone as a number: a leading 0 is dropped, and it needs
  // exactly 10 digits for India.
  // ⚠️ Same phone rules as the edit's own check above, validators/order.schema.ts and the
  // frontend addressEditSchema.ts.
  const isIndia = address.country === "IN";
  if (
    !(isIndia ? /^[1-9]\d{9}$/ : /^[1-9]\d{6,14}$/).test(address.phone ?? "")
  ) {
    return {
      status: "FAILED",
      error: isIndia
        ? "Shiprocket needs a 10-digit phone number for this order"
        : "Shiprocket needs a valid phone number for this order",
    };
  }

  // The country as Shiprocket stores it (a name). From the read when there is one,
  // else from our country table; never guessed.
  const countryName = held?.country || (await countryNameFor(address.country));
  if (!countryName) {
    return { status: "FAILED", error: UNEXPECTED_MESSAGE };
  }

  try {
    await updateOrderAddress({
      shiprocketOrderId,
      name: address.name ?? "",
      phone: address.phone ?? "",
      line1: address.line1 ?? "",
      line2: address.line2,
      city: address.city ?? "",
      state: address.state ?? "",
      country: countryName,
      pincode: address.zip ?? "",
    });
  } catch (err) {
    logger.error(
      { err, orderId },
      "Address sync: Shiprocket refused the address change"
    );
    return { status: "FAILED", error: PUSH_FAILED_MESSAGE };
  }

  let last: ShiprocketOrderAddress | null = null;
  let lastReadFailed = false;
  for (let attempt = 1; attempt <= ADDRESS_READBACK_ATTEMPTS; attempt++) {
    await sleep(ADDRESS_READBACK_DELAY_MS);
    try {
      last = await getOrderAddress(shiprocketOrderId);
      lastReadFailed = false;
      if (shiprocketHolds(address, last, { ignoreCase: true })) {
        return { status: "SYNCED", error: null };
      }
    } catch (err) {
      lastReadFailed = true;
      logger.warn({ err, orderId, attempt }, "Address sync: read-back failed");
    }
  }

  if (lastReadFailed || !last || isBlankRead(last)) {
    return {
      status: "UNVERIFIED",
      error: "Shiprocket accepted the change but it could not be read back",
    };
  }
  return { status: "FAILED", error: NOT_APPLIED_MESSAGE };
}

export async function syncOrderAddress(orderId: string, actor: AddressActor) {
  const claim = await claimSync(orderId);

  let outcome: SyncOutcome;
  try {
    outcome = await pushAndConfirm(claim, orderId);
  } catch (err) {
    logger.error({ err, orderId }, "Address sync failed unexpectedly");
    outcome = { status: "FAILED", error: UNEXPECTED_MESSAGE };
  }

  await prisma.orderAddressChange.updateMany({
    where: {
      id: { in: claim.coveredIds },
      syncStatus: "SYNCING",
      syncStartedAt: claim.startedAt,
    },
    data: {
      syncStatus: outcome.status,
      syncError: outcome.error,
      ...(outcome.status === "SYNCED" && claim.phoneChanged
        ? { syncNote: PHONE_NOT_CONFIRMED_NOTE }
        : {}),
      syncStartedAt: null,
      syncedAt: outcome.status === "SYNCED" ? new Date() : null,
      syncedById: outcome.status === "SYNCED" ? actor.id : null,
      syncedByEmail: outcome.status === "SYNCED" ? actor.email : null,
    },
  });

  logger.info(
    {
      orderId,
      status: outcome.status,
      covered: claim.coveredIds.length,
      adminId: actor.id,
    },
    "Order address sync finished"
  );

  return {
    status: outcome.status,
    error: outcome.error,
    covered: claim.coveredIds.length,
  };
}

// A Master admin says the address is right at Shiprocket (checked in its panel).
// For the case where Shiprocket can never confirm it. Needs a note, is recorded
// as MANUAL with who and when, and is refused once the AWB exists.
export async function markOrderAddressSynced(
  orderId: string,
  input: { note: string; upToSeq: number },
  actor: AddressActor
) {
  return prisma.$transaction(async (tx) => {
    await lockOrderAddress(tx, orderId);

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { awbNumber: true, shiprocketOrderId: true },
    });
    if (!order) {
      throw new NotFoundError("Order not found");
    }
    if (order.awbNumber) {
      throw new ConflictError(
        "The AWB is already generated, so the address is locked"
      );
    }
    // "Checked in the Shiprocket panel" needs an order there to check.
    if (!order.shiprocketOrderId) {
      throw new ConflictError(
        "There is no Shiprocket order to check yet. Try again when the order shows Ready to ship."
      );
    }

    await assertNoSyncInProgress(tx, orderId);

    // The admin confirms the changes they saw. A change made since (another admin,
    // another tab) was not checked, so it is never marked on their behalf.
    const unseen = await tx.orderAddressChange.count({
      where: { AND: [unsyncedWhere(orderId), { seq: { gt: input.upToSeq } }] },
    });
    if (unseen > 0) {
      throw new ConflictError(
        "The address was changed again after you opened this. Reload the order and check the new change too."
      );
    }

    const { count } = await tx.orderAddressChange.updateMany({
      where: { AND: [unsyncedWhere(orderId), { seq: { lte: input.upToSeq } }] },
      data: {
        syncStatus: "MANUAL",
        syncNote: input.note.trim(),
        syncError: null,
        syncStartedAt: null,
        syncedAt: new Date(),
        syncedById: actor.id,
        syncedByEmail: actor.email,
      },
    });
    if (count === 0) {
      throw new ConflictError("There is no unsynced address change to mark");
    }

    logger.info(
      { orderId, marked: count, adminId: actor.id },
      "Order address marked as synced by hand"
    );
    return { marked: count };
  });
}

// ============================================================
// GUARDS FOR "GENERATE AWB" (used by shiprocket.service Phase B)
// ============================================================

// Refuses while Shiprocket may still hold an old address.
export async function assertAddressSyncedForAwb(
  orderId: string
): Promise<void> {
  // Once the AWB exists nothing is left to guard: a change closed by
  // closeAddressChangesAfterAwb must not hide the real "already has an AWB" refusal.
  const open = await prisma.orderAddressChange.count({
    where: {
      orderId,
      syncStatus: { in: ADDRESS_SYNC_BLOCKING_STATUSES },
      order: { awbNumber: null },
    },
  });
  if (open > 0) {
    throw new ConflictError(
      "This order has an address change that Shiprocket does not have yet. Open the address history on the order page, press Retry sync, then generate the AWB."
    );
  }
}

// The highest change number of an order (0 when it has none). Phase B takes it
// when it starts and checks again just before it books the AWB.
export async function getLatestAddressSeq(orderId: string): Promise<number> {
  const latest = await prisma.orderAddressChange.findFirst({
    where: { orderId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return latest?.seq ?? 0;
}

export async function assertNoAddressChangeSince(
  orderId: string,
  seq: number
): Promise<void> {
  const newer = await prisma.orderAddressChange.count({
    where: { orderId, seq: { gt: seq } },
  });
  if (newer > 0) {
    throw new ConflictError(
      "The address was changed while the AWB was being prepared. Check the address history, then try again."
    );
  }
}

// An edit can commit during the single assignAwb call, after Phase B's last check. It
// cannot reach Shiprocket in time, and once the AWB exists Retry sync and Mark as synced
// are refused, so such a change would sit "waiting" for ever. Phase B closes it here as
// FAILED, with a message that tells the admin to check the label.
export async function closeAddressChangesAfterAwb(
  orderId: string,
  seqAtStart: number
): Promise<void> {
  const { count: open } = await prisma.orderAddressChange.updateMany({
    where: {
      orderId,
      seq: { gt: seqAtStart },
      syncStatus: { in: ADDRESS_SYNC_BLOCKING_STATUSES },
    },
    data: {
      syncStatus: "FAILED",
      syncError: AWB_DURING_CHANGE_MESSAGE,
      syncStartedAt: null,
    },
  });
  // A change that finished syncing inside the same window may have reached Shiprocket
  // before or after the AWB was booked: it keeps its status but carries the same note.
  const { count: synced } = await prisma.orderAddressChange.updateMany({
    where: {
      orderId,
      seq: { gt: seqAtStart },
      syncStatus: { in: ["SYNCED", "MANUAL"] },
    },
    data: { syncError: AWB_DURING_CHANGE_MESSAGE },
  });
  const count = open + synced;
  if (count > 0) {
    logger.error(
      { orderId, count },
      "Address changed while the AWB was being booked: the label needs checking"
    );
  }
}

// ============================================================
// FOR THE ADMIN ORDER PAGE
// ============================================================

export const ADDRESS_HISTORY_SELECT = {
  id: true,
  seq: true,
  createdAt: true,
  before: true,
  after: true,
  changedByEmail: true,
  syncStatus: true,
  syncError: true,
  syncNote: true,
  syncedAt: true,
  syncedByEmail: true,
} as const;
