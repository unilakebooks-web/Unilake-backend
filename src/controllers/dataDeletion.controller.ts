import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../lib/logger.js";
import { ValidationError } from "../utils/errors.js";
import {
  getDeletionOverview,
  releaseItem,
  retryItems,
  runCanaryNow,
  setGroupMode,
  undoGhosts,
} from "../services/dataDeletion.service.js";
import { deletionGroupSchema } from "../validators/dataDeletion.schema.js";

// Master only (the route is not in the sub-admin list). Ids and counts are logged, never personal data.

export const getDeletionOverviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await getDeletionOverview());
  }
);

export const setDeletionModeHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const group = deletionGroupSchema.safeParse(req.params.group);
    if (!group.success) throw new ValidationError("Unknown deletion group");
    const updated = await setGroupMode(group.data, req.body, req.user!.email);
    logger.info(
      { group: group.data, mode: updated.mode, actor: req.user!.id },
      "[Data deletion] mode changed"
    );
    sendSuccess(res, 200, updated);
  }
);

export const runDeletionCanaryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await runCanaryNow();
    logger.info(
      { actor: req.user!.id, passed: result.passed },
      "[Data deletion] canary run by an admin"
    );
    sendSuccess(res, 200, result);
  }
);

export const retryDeletionItemsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const count = await retryItems(req.body);
    logger.info(
      { actor: req.user!.id, ...req.body, count },
      "[Data deletion] retry"
    );
    sendSuccess(res, 200, { retried: count });
  }
);

export const releaseDeletionItemHandler = asyncHandler(
  async (req: Request, res: Response) => {
    await releaseItem(req.body.itemId);
    logger.info(
      { actor: req.user!.id, itemId: req.body.itemId },
      "[Data deletion] item released"
    );
    sendSuccess(res, 200, { released: true });
  }
);

export const undoGhostHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await undoGhosts(req.body);
    logger.info(
      {
        actor: req.user!.id,
        undone: result.undone,
        ids: result.ids,
        refused: result.refused.length,
      },
      "[Data deletion] ghosts undone"
    );
    sendSuccess(res, 200, result);
  }
);
