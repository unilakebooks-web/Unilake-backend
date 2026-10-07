import { z } from "zod";

// Admin customer list — GET /api/admin/customers and
// GET /api/admin/customers/export.
//
// A "customer" is an account with at least one PAID order. Always ordered by
// most recent purchase first, so there is deliberately no sortBy/sortOrder.
// Same page/pageSize bounds as listAdminUsersQuerySchema.

export const listAdminCustomersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Matched against name, account email and any phone used on a paid order.
  search: z.string().trim().min(1).optional(),
});

// The CSV export takes the same search but is never paginated — it is the
// whole (filtered) list.
export const exportAdminCustomersQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
});

export type ListAdminCustomersQueryInput = z.infer<
  typeof listAdminCustomersQuerySchema
>;
export type ExportAdminCustomersQueryInput = z.infer<
  typeof exportAdminCustomersQuerySchema
>;
