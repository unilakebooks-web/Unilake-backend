import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  createOrderSession,
  createPhotoUploadUrl,
  getOrderSessionId,
  updateOrderSession,
  confirmSessionPhoto,
  triggerGeneration,
  regeneratePage,
  attachUserToSession,
} from "../services/session.service.js";
import { regeneratePageParamsSchema } from "../validators/regenerate.schema.js";
import { ValidationError } from "../utils/errors.js";
import { generateSessionParamsSchema } from "../validators/generate.schema.js";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { sendToPrint } from "../services/session.service.js";
import {
  sendToPrintParamsSchema,
  sendToPrintBodySchema,
} from "../validators/sendToPrint.schema.js";

export const createSessionHandler = asyncHandler(
  async (req: Request, res: Response) => {
    let userId: string | undefined;
    try {
      const sessionData = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (sessionData?.user) {
        userId = sessionData.user.id;
      }
    } catch {
      // No valid session — that's fine, session stays anonymous
    }
    const session = await createOrderSession(req.body, userId);

    sendSuccess(res, 201, session);
  }
);

export const updateSessionHandler = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== "string") {
    throw new ValidationError("sessionId param is required");
  }

  const session = await updateOrderSession(sessionId, req.body);

  sendSuccess(res, 200, session);
});

export const getSessionHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    if (!sessionId || typeof sessionId !== "string") {
      throw new ValidationError("sessionId param is requried");
    }

    const session = await getOrderSessionId(sessionId);

    sendSuccess(res, 200, session);
  }
);

export const createPhotoUploadUrlHandler = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== "string") {
    throw new ValidationError("sessionId param is required");
  }

  const { fileExtension } = req.body;
  const result = await createPhotoUploadUrl(sessionId, fileExtension);

  sendSuccess(res, 200, result);
});

export const confirmSessionPhotoHandler = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== "string") {
    throw new ValidationError("sessionId param is required");
  }

  const { key } = req.body;
  const result = await confirmSessionPhoto(sessionId, key);

  sendSuccess(res, 200, result);
});

export const generateSessionHandler = asyncHandler(async (req, res) => {
  const result = generateSessionParamsSchema.safeParse({
    sessionId: req.params.sessionId,
  });

  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(", ")
    );
  }

  const genResult = await triggerGeneration(result.data.sessionId);
  sendSuccess(res, 200, genResult);
});

export const regeneratePageHandler = asyncHandler(async (req, res) => {
  const result = regeneratePageParamsSchema.safeParse({
    sessionId: req.params.sessionId,
    pageNumber: req.params.pageNumber,
  });

  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(", ")
    );
  }

  const regenResult = await regeneratePage(
    result.data.sessionId,
    result.data.pageNumber
  );

  sendSuccess(res, 200, regenResult);
});

export const attachUserHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== "string") {
      throw new ValidationError("sessionId param is required");
    }

    const userId = req.user!.id;

    const session = await attachUserToSession(sessionId, userId);

    sendSuccess(res, 200, session);
  }
);

export const sendToPrintHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // Params validation
    const params = sendToPrintParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new ValidationError(
        params.error.issues.map((i) => i.message).join(", ")
      );
    }

    // Body validation — same safeParse pattern as regeneratePageHandler
    // (rather than validateBody middleware) since we're already parsing
    // params inline. Keeps error handling consistent inside this handler.
    const body = sendToPrintBodySchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(
        body.error.issues.map((i) => i.message).join(", ")
      );
    }

    // requireLoggedIn middleware guarantees req.user is set at this point
    // (mounted globally on /api/user in app.ts). The ! is safe here.
    const userId = req.user!.id;

    const result = await sendToPrint(params.data.sessionId, userId, body.data);

    sendSuccess(res, 200, result);
  }
);