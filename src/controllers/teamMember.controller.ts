import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { createTeamMember, deleteTeamMember, getActiveTeamMembers, getAllTeamMembers, getTeamMemberUploadUrl, toggleTeamMemberStatus, updateTeamMember } from "../services/teamMember.service.js";

export const getTeamMemberUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getTeamMemberUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);


export const createTeamMemberHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const teamMember = await createTeamMember(req.body);
    sendSuccess(res, 201, teamMember);
  }
);


export const updateTeamMemberHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const teamMember = await updateTeamMember(id as string, req.body);
    sendSuccess(res, 200, teamMember);
  }
);

export const toggleTeamMemberStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const teamMember = await toggleTeamMemberStatus(id as string);
    sendSuccess(res, 200, teamMember);
  }
);


export const deleteTeamMemberHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteTeamMember(id as string);
    res.status(204).send();
  }
);

export const getAllTeamMembersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const teamMembers = await getAllTeamMembers();
    sendSuccess(res, 200, teamMembers);
  }
);


export const getActiveTeamMembersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const teamMembers = await getActiveTeamMembers();
    sendSuccess(res, 200, teamMembers);
  }
);