import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { listAdminUsers, updateUserRole } from "../services/user.service.js";
import {
  listAdminUsersQuerySchema,
  userIdParamsSchema,
  type UpdateUserRoleInput,
} from "../validators/user.schema.js";

// GET /api/admin/users
// Auth: requireAdmin (applied at router mount in app.ts)
// Paginated, searchable (name/email), role-filterable list of every account.

export const listAdminUsersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = listAdminUsersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const result = await listAdminUsers(parseResult.data);

    sendSuccess(res, 200, result);
  }
);

// PATCH /api/admin/users/:userId/role
// Auth: requireAdmin (applied at router mount in app.ts)
// Body: { role: "ADMIN" | "USER" } — validated via validateBody in the route file.
//
// The acting admin comes from the session cookie, never the body. Self-demotion
// and last-admin demotion are refused with 409 by the service.

export const updateUserRoleHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = userIdParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid user ID"
      );
    }

    const { role } = req.body as UpdateUserRoleInput;
    const actorId = req.user!.id;

    const user = await updateUserRole(actorId, parseResult.data.userId, role);

    sendSuccess(res, 200, user, "Role updated");
  }
);
