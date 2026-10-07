import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  getContentHealth,
  getStatsSummary,
  getStatsTimeseries,
} from "../services/stats.service.js";
import { statsRangeQuerySchema } from "../validators/stats.schema.js";

// Admin overview dashboard. Three endpoints rather than one so the page can
// load them independently — the ops-triage band renders off /summary without
// waiting on the chart, and a failing aggregate degrades one card instead of
// blanking the screen.
//
// All three are mounted under /api/admin, which already applies requireAdmin at
// the mount point in app.ts. No guard belongs in this file.

// GET /api/admin/stats/summary?range=7d|30d|all
//
// KPIs, the live pipeline snapshot, needs-attention counts, top comics and the
// most recent orders. `range` affects money and volume only — status counts and
// triage numbers are always current.

export const getStatsSummaryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = statsRangeQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const summary = await getStatsSummary(parseResult.data.range);

    sendSuccess(res, 200, summary);
  }
);

// GET /api/admin/stats/timeseries?range=7d|30d|all
//
// Orders and revenue bucketed on IST day boundaries (or months for all-time).
// Buckets are zero-filled, so the series always spans the full range.

export const getStatsTimeseriesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const parseResult = statsRangeQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues[0]?.message ?? "Invalid query parameters"
      );
    }

    const timeseries = await getStatsTimeseries(parseResult.data.range);

    sendSuccess(res, 200, timeseries);
  }
);

// GET /api/admin/stats/content-health
//
// Storefront configuration state. No query params — this is always a statement
// about right now, and nothing on it varies with a date range.

export const getContentHealthHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const health = await getContentHealth();

    sendSuccess(res, 200, health);
  }
);
