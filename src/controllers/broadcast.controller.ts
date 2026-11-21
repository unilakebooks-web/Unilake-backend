import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  cancelBroadcast,
  createBroadcast,
  deleteBroadcastDraft,
  getAudienceCounts,
  getBroadcast,
  listBroadcasts,
  previewBroadcast,
  sendTestBroadcast,
  startBroadcast,
  updateBroadcast,
} from "../services/broadcast.service.js";

export const listBroadcastsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await listBroadcasts());
  }
);

export const getAudienceCountsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await getAudienceCounts());
  }
);

export const getBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await getBroadcast(req.params.id as string));
  }
);

export const createBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const admin = { id: req.user!.id, email: req.user!.email };
    sendSuccess(res, 201, await createBroadcast(req.body, admin));
  }
);

export const updateBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      200,
      await updateBroadcast(req.params.id as string, req.body)
    );
  }
);

export const deleteBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    await deleteBroadcastDraft(req.params.id as string);
    res.status(204).send();
  }
);

export const previewBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await previewBroadcast(req.params.id as string));
  }
);

// The test goes to the signed-in admin's own login address; the route takes no address.
export const sendTestBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      200,
      await sendTestBroadcast(req.params.id as string, req.user!.email)
    );
  }
);

export const startBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      200,
      await startBroadcast(
        req.params.id as string,
        req.body.confirmRecipientCount
      )
    );
  }
);

export const cancelBroadcastHandler = asyncHandler(
  async (req: Request, res: Response) => {
    sendSuccess(res, 200, await cancelBroadcast(req.params.id as string));
  }
);
