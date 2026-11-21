import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  applyUnsubscribe,
  getMarketingConsent,
  getUnsubscribeInfo,
  setMarketingConsent,
} from "../services/emailOptOut.service.js";

/** The token is the only thing in these URLs; keep it out of caches and out of Referer headers. */
function noTrace(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export const getUnsubscribeInfoHandler = asyncHandler(
  async (req: Request, res: Response) => {
    noTrace(res);
    sendSuccess(res, 200, await getUnsubscribeInfo(req.params.token as string));
  }
);

// Also the target of the one-click POST a mail app sends (form body, no Origin): the body is not read.
export const applyUnsubscribeHandler = asyncHandler(
  async (req: Request, res: Response) => {
    noTrace(res);
    sendSuccess(res, 200, await applyUnsubscribe(req.params.token as string));
  }
);

export const getMarketingConsentHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await getMarketingConsent(req.user!.id));
  }
);

export const setMarketingConsentHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      200,
      await setMarketingConsent(
        { id: req.user!.id, email: req.user!.email },
        req.body.optedIn
      )
    );
  }
);
