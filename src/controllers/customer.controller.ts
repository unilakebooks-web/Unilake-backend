import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  exportAdminCustomersCsv,
  listAdminCustomers,
} from "../services/customer.service.js";
import {
  exportAdminCustomersQuerySchema,
  listAdminCustomersQuerySchema,
} from "../validators/customer.schema.js";

// GET /api/admin/customers
// Auth: requireAdmin (applied at router mount in app.ts)
// Paginated, searchable list of every account with at least one paid order.

export const listAdminCustomersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = listAdminCustomersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const result = await listAdminCustomers(parseResult.data);

    sendSuccess(res, 200, result);
  }
);

// GET /api/admin/customers/export
// Auth: requireAdmin (applied at router mount in app.ts)
// The same list as CSV — every matching customer, not one page. A raw file
// response, not the JSON envelope.

export const exportAdminCustomersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = exportAdminCustomersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const csv = await exportAdminCustomersCsv(parseResult.data.search);
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="unilake-customers-${date}.csv"`
    );
    // Customer contact details — never let a shared cache keep a copy.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(csv);
  }
);
