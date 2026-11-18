import type { Request, Response } from "express";
import { config } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { isValidSweepSecret } from "../utils/sweepAuth.js";
import { runScheduledSweeps } from "../services/scheduledSweeps.service.js";

// New file so other work on controllers cannot conflict.

export const runSweepsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // No SWEEP_SECRET configured = the endpoint does not exist. The variable is
    // optional on purpose: deploying this code must never stop the server from starting.
    if (!config.scheduledSweepSecret) throw new NotFoundError();
    if (
      !isValidSweepSecret(
        req.header("x-sweep-secret"),
        config.scheduledSweepSecret
      )
    ) {
      throw new UnauthorizedError("Invalid sweep secret");
    }
    sendSuccess(res, 200, await runScheduledSweeps());
  }
);
