import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { UnauthorizedError } from "../utils/errors.js";

export const requireLoggedIn = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sessionData = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!sessionData || !sessionData.session) {
      return next(new UnauthorizedError("Authentication required."));
    }

    req.session = sessionData.session;
    req.user = sessionData.user;


    return next();
  } catch (error: any) {
    return next(error);
  }
};
