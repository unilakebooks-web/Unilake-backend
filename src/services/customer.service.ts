import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type { OrderStatus } from "../generated/prisma/client.js";
import type { ListAdminCustomersQueryInput } from "../validators/customer.schema.js";

// ============================================================
// ADMIN CUSTOMER LIST
// ============================================================
//
// One row per ACCOUNT that has bought at least one book — the "who are our
// customers and how do we reach them" view. Distinct from:
//   - /admin/users  — every account, buyers or not;
//   - /admin/orders — one row per order.
//
// Contact details, by decision:
//   - email: the ACCOUNT email (User.email), the one they log in with;
//   - phone: the shipping phone from their MOST RECENT paid order. Accounts
//     carry no phone of their own — orders are the only place one exists.
//
// Aggregation happens in memory over every paid order. One query, no N+1, and
// it lets the list sort by last purchase — which Prisma cannot order users by
// directly. Fine at current volume (hundreds to low thousands of orders); if it
// ever grows past that, move the grouping into SQL.

/**
 * Order statuses that mean "this customer paid". Everything from payment
 * capture to delivery. Excludes CREATED (checkout opened, never paid) and
 * CANCELLED.
 */
export const PAID_ORDER_STATUSES: OrderStatus[] = [
  "PAID",
  "GENERATED",
  "CONFIRMED",
  "SHIPROCKET_FAILED",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
];

/** Amount paid in one currency. Totals are never summed across currencies. */
export interface CurrencyTotal {
  currency: string;
  /** Decimal as a string, two places — same convention as Order.amount. */
  amount: string;
}

export interface AdminCustomerRow {
  userId: string;
  name: string;
  /** Account (login) email. */
  email: string;
  /** Shipping phone from the most recent paid order; null if none recorded. */
  phone: string | null;
  /** Number of paid orders. */
  ordersCount: number;
  /** One entry per currency they have paid in, largest first. */
  totals: CurrencyTotal[];
  /** Distinct comic titles bought, most recent purchase first. */
  comicsBought: string[];
  firstPurchaseAt: Date;
  lastPurchaseAt: Date;
}

/** Digits only — lets "98765 43210" match a stored "+919876543210". */
const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * Builds the full customer list — every account with a paid order — newest
 * purchase first, optionally narrowed by `search`.
 *
 * Search is case-insensitive against the name and account email, and against
 * EVERY phone the customer has used on a paid order (not only the one shown),
 * so an admin can find someone by an older number too. When the query has 3+
 * digits, phones are also compared digits-only, so spacing and country-code
 * formatting don't matter.
 */
export async function buildCustomerList(search?: string): Promise<AdminCustomerRow[]> {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: PAID_ORDER_STATUSES },
      // Checkout refuses an anonymous session, so every paid order has a user.
      // The filter is a guard, not an expectation.
      orderSession: { userId: { not: null } },
    },
    // Newest first, so the first order seen per customer is their latest —
    // that is what picks the phone and orders comicsBought.
    orderBy: { createdAt: "desc" },
    select: {
      amount: true,
      currency: true,
      createdAt: true,
      shippingName: true,
      shippingPhone: true,
      orderSession: {
        select: {
          user: { select: { id: true, name: true, email: true } },
          comic: { select: { title: true } },
        },
      },
    },
  });

  // Working shape per customer while folding the orders in.
  type Accumulator = Omit<AdminCustomerRow, "totals" | "comicsBought"> & {
    totals: Map<string, Prisma.Decimal>;
    comics: Set<string>;
    phones: Set<string>;
  };

  const byUser = new Map<string, Accumulator>();

  for (const order of orders) {
    const user = order.orderSession.user;
    if (!user) continue;

    let acc = byUser.get(user.id);
    if (!acc) {
      // First (= newest) order for this customer.
      acc = {
        userId: user.id,
        // Better Auth always stores a name, but it can be empty for some
        // social sign-ins — fall back to the name they shipped to.
        name: user.name.trim() || order.shippingName?.trim() || "",
        email: user.email,
        phone: null,
        ordersCount: 0,
        totals: new Map(),
        comics: new Set(),
        phones: new Set(),
        firstPurchaseAt: order.createdAt,
        lastPurchaseAt: order.createdAt,
      };
      byUser.set(user.id, acc);
    }

    acc.ordersCount += 1;
    // Orders arrive newest first, so each later one is older.
    acc.firstPurchaseAt = order.createdAt;

    // Latest order with a phone wins — normally the very first one.
    if (order.shippingPhone) {
      if (acc.phone === null) acc.phone = order.shippingPhone;
      acc.phones.add(order.shippingPhone);
    }

    const running = acc.totals.get(order.currency) ?? new Prisma.Decimal(0);
    acc.totals.set(order.currency, running.plus(order.amount));

    acc.comics.add(order.orderSession.comic.title);
  }

  let customers = [...byUser.values()];

  if (search) {
    const q = search.toLowerCase();
    const qDigits = digitsOf(search);

    customers = customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        [...c.phones].some(
          (phone) =>
            phone.toLowerCase().includes(q) ||
            (qDigits.length >= 3 && digitsOf(phone).includes(qDigits))
        )
    );
  }

  // Map insertion order already follows newest purchase first, but sort
  // explicitly so the contract does not depend on that.
  customers.sort((a, b) => b.lastPurchaseAt.getTime() - a.lastPurchaseAt.getTime());

  return customers.map(({ totals, comics, phones: _phones, ...rest }) => ({
    ...rest,
    totals: [...totals.entries()]
      .sort(([, a], [, b]) => b.comparedTo(a))
      .map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
    comicsBought: [...comics],
  }));
}

/** Paginated customer list for GET /api/admin/customers. */
export async function listAdminCustomers(filters: ListAdminCustomersQueryInput) {
  const all = await buildCustomerList(filters.search);

  const total = all.length;
  const start = (filters.page - 1) * filters.pageSize;

  return {
    customers: all.slice(start, start + filters.pageSize),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}

// ============================================================
// CSV EXPORT
// ============================================================

/** YYYY-MM-DD in India time — the business's day, as on the stats dashboard. */
const toIstDate = (date: Date) =>
  date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** A phone-looking value: optional +, then digits, spaces, dashes, brackets. */
const PHONE_LIKE = /^\+?[\d\s()-]+$/;

/**
 * One CSV cell, safely quoted.
 *
 * Formula injection: spreadsheet apps execute a cell that starts with `=`,
 * `+`, `-`, `@` (or a tab/CR). Names and emails are customer-typed, so such a
 * cell is prefixed with `'` to force it to plain text. Phone numbers are the
 * exception — "+919876543210" is legitimate and must stay as-is.
 */
function csvCell(value: string | number): string {
  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text) && !PHONE_LIKE.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADERS = [
  "Name",
  "Email",
  "Phone",
  "Books Bought",
  "Total Spent",
  "Comics Bought",
  "First Purchase",
  "Last Purchase",
];

/**
 * The whole (optionally searched) customer list as CSV text.
 *
 * Starts with a UTF-8 BOM so Excel reads non-English names (e.g. Hindi)
 * correctly instead of as garbled characters; CRLF line endings per RFC 4180.
 */
export async function exportAdminCustomersCsv(search?: string): Promise<string> {
  const customers = await buildCustomerList(search);

  const lines = [
    CSV_HEADERS.join(","),
    ...customers.map((c) =>
      [
        c.name,
        c.email,
        c.phone ?? "",
        c.ordersCount,
        c.totals.map((t) => `${t.currency} ${t.amount}`).join("; "),
        c.comicsBought.join("; "),
        toIstDate(c.firstPurchaseAt),
        toIstDate(c.lastPurchaseAt),
      ]
        .map(csvCell)
        .join(",")
    ),
  ];

  return "﻿" + lines.join("\r\n") + "\r\n";
}
