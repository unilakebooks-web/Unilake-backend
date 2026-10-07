import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { UnauthorizedError, ForbiddenError} from "../utils/errors.js";

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sessionData = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!sessionData || !sessionData.session) {
      return next(new UnauthorizedError("Unauthorized: Active session required."));
    }

    if (sessionData.user.role !== "ADMIN") {
      return next(new ForbiddenError("Forbidden: Admin privileges required."));
    }

    req.session = sessionData.session;
    req.user = sessionData.user;

    return next();
  } catch (error) {
    return next(error);
  }
};
