import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  buildSamplePdf,
  createSample,
  discardSample,
  listSamples,
} from "../services/sampleBook.service.js";
import { sampleSessionParamsSchema } from "../validators/sample.schema.js";

// Auth: requireStaff at the router mount in app.ts; Master only (not in subAdminRoutes.ts). Bodies are validated by validateBody in the routes.

function parseSessionId(params: Request["params"]): string {
  const parsed = sampleSessionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ValidationError("Invalid sample ID format");
  }
  return parsed.data.sessionId;
}

// POST /api/admin/samples
export const createSampleHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const session = await createSample(req.body, req.user!.id);
    sendSuccess(res, 201, {
      sessionId: session.id,
      wsRoomToken: session.wsRoomToken,
      expiresAt: session.expiresAt,
    });
  }
);

// GET /api/admin/samples
export const listSamplesHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    sendSuccess(res, 200, await listSamples());
  }
);

// DELETE /api/admin/samples/:sessionId — ends the sample now; the sweep removes its files.
export const discardSampleHandler = asyncHandler(
  async (req: Request, res: Response) => {
    await discardSample(parseSessionId(req.params));
    sendSuccess(res, 200, { discarded: true });
  }
);

// POST /api/admin/samples/:sessionId/pdf — sends the PDF of the chosen versions; stores nothing.
export const downloadSamplePdfHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const bytes = await buildSamplePdf(parseSessionId(req.params), req.body);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="sample.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(bytes);
  }
);
