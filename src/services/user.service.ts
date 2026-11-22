import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { Prisma } from "../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import type {
  ListAdminUsersQueryInput,
  UserRole,
} from "../validators/user.schema.js";

// ============================================================
// ADMIN USER MANAGEMENT
// ============================================================
//
// Lists every account and lets an admin promote/demote others. User rows are
// created and owned by Better Auth; this service only ever reads them and
// writes the `role` column.
//
// A role change takes effect on the target's very next request: requireStaff
// calls auth.api.getSession() per request and Better Auth's cookie cache is
// off, so the role is re-read from the DB every time. A demoted admin is NOT
// signed out - they simply become a normal customer (agreed behaviour).

/**
 * The only fields the admin list exposes. Explicit so nothing auth-internal
 * (emailVerified, sessions, accounts/tokens) can leak via a future `include`.
 */
const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

/**
 * Serialises every demotion. Two admins demoting each other at the same moment
 * would otherwise both read adminCount = 2, both pass the last-admin check, and
 * leave zero admins. Transaction-scoped, so it releases on commit/rollback.
 */
const ROLE_CHANGE_LOCK_KEY = "admin-user-role-change";

export async function listAdminUsers(filters: ListAdminUsersQueryInput) {
  const where: Prisma.UserWhereInput = {};

  if (filters.role !== undefined) {
    where.role = filters.role;
  }

  if (filters.search !== undefined) {
    const q = filters.search; // already trimmed + min-length checked in Zod
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ];
  }

  const skip = (filters.page - 1) * filters.pageSize;
  const take = filters.pageSize;

  // adminCount is global (ignores search/filter) - it drives the header and
  // lets the UI explain why the last admin can't be demoted.
  const [users, total, adminCount] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: ADMIN_USER_SELECT,
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: { role: "ADMIN" } }),
  ]);

  return {
    users,
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize),
    },
    adminCount,
  };
}

const ROLE_CHANGED_MESSAGE =
  "This user's role changed while you were saving. Reload and try again.";

/**
 * The write for a change that is not a demotion. It only applies if the role is still the one that was
 * read: promoting someone to ADMIN while this request holds an older read would otherwise be undone
 * without the last-admin check and the lock (a demotion that looked like a non-demotion).
 */
async function changeRoleIfUnchanged(
  userId: string,
  expectedRole: string,
  newRole: UserRole
) {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, role: expectedRole },
    data: { role: newRole },
  });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ADMIN_USER_SELECT,
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  // Nothing matched: another request changed this user first. If it already made the change that was asked
  // for (two Master admins doing the same thing at once), that is a success; anything else is refused.
  if (count === 0 && user.role !== newRole) {
    throw new ConflictError(ROLE_CHANGED_MESSAGE);
  }
  return { user, changed: count === 1 };
}

/**
 * Change a user's role.
 *
 * Guards, in order:
 *   1. Target must exist                         → 404
 *   2. Already that role                         → no-op, returned as-is
 *   3. An admin cannot demote themselves         → 409
 *   4. The last remaining Master admin cannot be demoted → 409
 *      (inside the lock the target is read again: already changed → success, no longer a Master → 409)
 *
 * Guard 4 and the write share one transaction behind an advisory lock - see
 * ROLE_CHANGE_LOCK_KEY. Inside it the target is read again (it may have changed since the first
 * read), and only Master admins are counted. A change that is not a demotion cannot lower the
 * Master count, so it skips the lock; its write only applies if the role is still the one read
 * (changeRoleIfUnchanged).
 */
export async function updateUserRole(
  actorId: string,
  targetUserId: string,
  newRole: UserRole
) {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: ADMIN_USER_SELECT,
  });

  if (!target) {
    throw new NotFoundError("User not found");
  }

  if (target.role === newRole) {
    return target;
  }

  const isDemotion = target.role === "ADMIN" && newRole !== "ADMIN";

  if (isDemotion && actorId === targetUserId) {
    throw new ConflictError("You can't remove your own Master admin access.");
  }

  const result = isDemotion
    ? await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ROLE_CHANGE_LOCK_KEY}))`;

        // The read above was made before the lock: read again, now that nobody else can change a role.
        const current = await tx.user.findUnique({
          where: { id: targetUserId },
          select: ADMIN_USER_SELECT,
        });
        if (!current) {
          throw new NotFoundError("User not found");
        }
        if (current.role === newRole) {
          return { user: current, changed: false };
        }
        if (current.role !== "ADMIN") {
          throw new ConflictError(ROLE_CHANGED_MESSAGE);
        }

        const adminCount = await tx.user.count({ where: { role: "ADMIN" } });
        if (adminCount <= 1) {
          throw new ConflictError("There must be at least one Master admin.");
        }

        const user = await tx.user.update({
          where: { id: targetUserId },
          data: { role: newRole },
          select: ADMIN_USER_SELECT,
        });
        return { user, changed: true };
      })
    : await changeRoleIfUnchanged(targetUserId, target.role, newRole);

  // Someone else already made this change: nothing was written here, so nothing is logged.
  if (!result.changed) {
    return result.user;
  }

  logger.info(
    { actorId, targetUserId, from: target.role, to: newRole },
    "User role changed"
  );

  return result.user;
}
