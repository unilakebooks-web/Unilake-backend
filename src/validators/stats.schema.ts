import { z } from "zod";
import { DEFAULT_STATS_RANGE, STATS_RANGES } from "../config/stats.js";

// Query params for GET /api/admin/stats/summary and /timeseries.
//
// This schema is `.safeParse`d inside the controller rather than applied as
// route middleware — `validateBody` only covers bodies and `validateQuery` does
// not exist in this project. Same pattern as listAdminOrdersQuerySchema.
//
// `.default()` means an omitted `?range=` is not an error: the dashboard's own
// default view and a bare request resolve to the same 30-day window.
export const statsRangeQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default(DEFAULT_STATS_RANGE),
});

export type StatsRangeQueryInput = z.infer<typeof statsRangeQuerySchema>;
