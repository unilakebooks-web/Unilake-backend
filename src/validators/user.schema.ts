import { z } from "zod";

// Admin user management — GET /api/admin/users and PATCH /api/admin/users/:userId/role.
//
// Role values match the strings Better Auth stores in User.role (see the
// `additionalFields.role` config in lib/auth.ts). Uppercase only — "admin"
// is rejected rather than silently normalised.

export const UserRoleEnum = z.enum(["ADMIN", "USER"]);

// Query params for GET /api/admin/users. Always ordered newest joined first,
// so there is deliberately no sortBy/sortOrder. Same page/pageSize bounds as
// listAdminOrdersQuerySchema.
export const listAdminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  role: UserRoleEnum.optional(),
});

// Body for PATCH /api/admin/users/:userId/role
export const updateUserRoleSchema = z.object({
  role: UserRoleEnum,
});

// Better Auth generates its own random string ids for users — NOT uuids — so
// this only checks presence, unlike the order/session params schemas.
export const userIdParamsSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
});

export type UserRole = z.infer<typeof UserRoleEnum>;
export type ListAdminUsersQueryInput = z.infer<typeof listAdminUsersQuerySchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
