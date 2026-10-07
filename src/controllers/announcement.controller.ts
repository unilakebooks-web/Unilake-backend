import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';
import { createAnnouncement, deleteAnnouncement, getActiveAnnouncements, listAnnouncements, reorderAnnouncements, toggleAnnouncementStatus, updateAnnouncement } from '../services/announcement.service.js';

export const createAnnouncementHandler = asyncHandler(async (req: Request, res: Response) => {
  const announcement = await createAnnouncement(req.body);
  sendSuccess(res, 201, announcement);
});


export const updateAnnouncementHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const announcement = await updateAnnouncement(id as string, req.body);
  sendSuccess(res, 200, announcement);
});


export const listAnnouncementsHandler = asyncHandler(async (req: Request, res: Response) => {
  const announcements = await listAnnouncements();
  sendSuccess(res, 200, announcements);
});

export const toggleAnnouncementStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const announcement = await toggleAnnouncementStatus(id as string);
  sendSuccess(res, 200, announcement);
});

export const reorderAnnouncementsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { orderedIds } = req.body;
  const announcements = await reorderAnnouncements(orderedIds);
  sendSuccess(res, 200, announcements);
});

export const deleteAnnouncementHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await deleteAnnouncement(id as string);
  res.status(204).send();
});

export const getActiveAnnouncementsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const announcements = await getActiveAnnouncements();
    sendSuccess(res, 200, announcements);
  }
);