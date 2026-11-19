import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { isSubAdminRoute } from "../config/subAdminRoutes.js";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.js";

// The guard of the whole /api/admin router (app.ts). A Master admin ("ADMIN") passes everything, as
// requireAdmin always allowed. A sub-admin ("SUB_ADMIN") passes only the routes listed in
// config/subAdminRoutes.ts; any other route, and any other role (including a value we do not know),
// is refused. requireAdmin.ts is kept as it was but is no longer mounted.
//
// The role is read from the database on every request (better-auth's cookie cache is off), so a
// role change applies to the next request.
export const requireStaff = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sessionData = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!sessionData || !sessionData.session) {
      return next(
        new UnauthorizedError("Unauthorized: Active session required.")
      );
    }

    const role = sessionData.user.role;
    const allowed =
      role === "ADMIN" ||
      (role === "SUB_ADMIN" && isSubAdminRoute(req.method, req.path));

    if (!allowed) {
      return next(new ForbiddenError("Forbidden: Admin privileges required."));
    }

    req.session = sessionData.session;
    req.user = sessionData.user;

    return next();
  } catch (error) {
    return next(error);
  }
};
