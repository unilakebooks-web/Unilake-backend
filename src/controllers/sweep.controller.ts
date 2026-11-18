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
    const outcome = await runScheduledSweeps();
    // A failed or timed-out sweep answers 500 so Cloud Scheduler can show and alert on it; a skipped run is 200.
    if (outcome.results.some((r) => r.error)) {
      res.status(500).json({
        success: false,
        error: { code: "SWEEP_FAILED", message: "One or more sweeps failed" },
        data: outcome,
      });
      return;
    }
    sendSuccess(res, 200, outcome);
  }
);
