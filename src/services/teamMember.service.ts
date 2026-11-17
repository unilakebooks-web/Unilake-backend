import { randomUUID } from "node:crypto";
import { deleteFile, getPublicUrl, getSignedUploadUrl } from "../lib/r2.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";

const UPLOAD_EXPIRY_SECONDS = 15 * 60;

// The order customers and the admin see: the admin's arrangement first.
// createdAt and id only break ties (two concurrent creates can read the same
// max), so the order is always deterministic.
const TEAM_MEMBER_ORDER_BY = [
  { sortOrder: "asc" as const },
  { createdAt: "desc" as const },
  { id: "asc" as const },
];

// Where a new member appears (D-032): at the END, so adding someone never pushes
// the people the admin placed first down. Change this one constant to put new
// members at the start instead.
const NEW_TEAM_MEMBER_POSITION: "start" | "end" = "end";

async function nextTeamMemberSortOrder() {
  const edge = await prisma.teamMember.findFirst({
    orderBy: { sortOrder: NEW_TEAM_MEMBER_POSITION === "end" ? "desc" : "asc" },
    select: { sortOrder: true },
  });
  if (!edge) return 0;
  return NEW_TEAM_MEMBER_POSITION === "end" ? edge.sortOrder + 1 : edge.sortOrder - 1;
}


export async function getTeamMemberUploadUrl(data: {
  fileName: string;
  contentType: string;
}) {
    const safeFileName = data.fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `team-members/${randomUUID()}-${safeFileName}`;

  const uploadUrl = await getSignedUploadUrl(
    "public",
    key,
    data.contentType,
    UPLOAD_EXPIRY_SECONDS
  );

  logger.info({ key }, "Generated team member photo upload URL");

  return { uploadUrl, key };
}


export async function createTeamMember(data: {
  name: string;
  role: string;
  description?: string;
  imageKey?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  twitterUrl?: string;
}) {
  const sortOrder = await nextTeamMemberSortOrder();

  const teamMember = await prisma.teamMember.create({
    data: {
      name: data.name,
      role: data.role,
      sortOrder,
      ...(data.description !== undefined && { description: data.description }),
      ...(data.imageKey !== undefined && { imageUrl: getPublicUrl(data.imageKey) }),
      ...(data.linkedinUrl !== undefined && { linkedinUrl: data.linkedinUrl }),
      ...(data.instagramUrl !== undefined && { instagramUrl: data.instagramUrl }),
      ...(data.twitterUrl !== undefined && { twitterUrl: data.twitterUrl }),
    },
  });

  logger.info({ teamMemberId: teamMember.id }, "Team member created");

  return teamMember;
}



export async function updateTeamMember(
  id: string,
  data: {
    name?: string;
    role?: string;
    description?: string | null;
    imageKey?: string | null;
    linkedinUrl?: string | null;
    instagramUrl?: string | null;
    twitterUrl?: string | null;
  }
) {
  const existing = await prisma.teamMember.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Team member not found");
  }

  const updateData: Record<string, unknown> = {};

  // `!== undefined`, not a truthiness check, so an explicit null reaches
  // Prisma and actually clears the column.
  if (data.name !== undefined) updateData.name = data.name;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.linkedinUrl !== undefined) updateData.linkedinUrl = data.linkedinUrl;
  if (data.instagramUrl !== undefined) updateData.instagramUrl = data.instagramUrl;
  if (data.twitterUrl !== undefined) updateData.twitterUrl = data.twitterUrl;

  // Image arrives as an R2 key and is stored as a resolved public URL.
  // null = remove the photo, a key = replace it, omitted = leave it alone.
  //
  // Guard on `oldUrl !== newUrl` so re-submitting the same key does not delete
  // the file the row still points at. Same guard as updatePage in page.service.ts.
  let oldR2Key: string | null = null;

  if (data.imageKey !== undefined) {
    const newImageUrl =
      data.imageKey === null ? null : getPublicUrl(data.imageKey);

    updateData.imageUrl = newImageUrl;

    if (existing.imageUrl && existing.imageUrl !== newImageUrl) {
      const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
      oldR2Key = existing.imageUrl.replace(`${publicBase}/`, "");
    }
  }

  const updated = await prisma.teamMember.update({
    where: { id },
    data: updateData,
  });

  // Clean up the replaced/removed file after the DB write succeeds.
  // Best-effort: a failed delete leaves an orphan file, not a broken row.
  if (oldR2Key) {
    try {
      await deleteFile("public", oldR2Key);
      logger.info({ teamMemberId: id, oldR2Key }, "Old team member image deleted from R2");
    } catch (error) {
      logger.warn({ error, teamMemberId: id, oldR2Key }, "Failed to delete old image from R2");
    }
  }

  logger.info({ teamMemberId: id, updatedFields: Object.keys(updateData) }, "Team member updated");

  return updated;
}




export async function toggleTeamMemberStatus(id: string) {
  const existing = await prisma.teamMember.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Team member not found");
  }

  const updated = await prisma.teamMember.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info({ teamMemberId: id, isActive: updated.isActive }, "Team member status toggled");

  return updated;
}


export async function deleteTeamMember(id: string) {
  const existing = await prisma.teamMember.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Team member not found");
  }

  let oldR2Key: string | null = null;

  if (existing.imageUrl) {
    const publicBase = config.r2.publicUrlBase.replace(/\/$/, "");
    oldR2Key = existing.imageUrl.replace(`${publicBase}/`, "");
  }

  await prisma.teamMember.delete({ where: { id } });

  if (oldR2Key) {
    try {
      await deleteFile("public", oldR2Key);
      logger.info({ teamMemberId: id, oldR2Key }, "Team member and R2 image deleted");
    } catch (error) {
      logger.warn({ error, teamMemberId: id, oldR2Key }, "Team member deleted but R2 cleanup failed");
    }
  } else {
    logger.info({ teamMemberId: id }, "Team member deleted (no image to clean up)");
  }
}

export async function getAllTeamMembers() {
  const teamMembers = await prisma.teamMember.findMany({
    orderBy: TEAM_MEMBER_ORDER_BY,
  });

  return teamMembers;
}


export async function getActiveTeamMembers() {
  const teamMembers = await prisma.teamMember.findMany({
    where: { isActive: true },
    orderBy: TEAM_MEMBER_ORDER_BY,
  });

  return teamMembers;
}

export async function reorderTeamMembers(orderedIds: string[]) {
  // The admin table shows every member, hidden ones too, so the reorder must be
  // the COMPLETE list. If it is not (another admin added or removed someone
  // since the page loaded) the order saved would be wrong: refuse and let the
  // admin reload.
  const existing = await prisma.teamMember.findMany({
    where: { id: { in: orderedIds } },
    select: { id: true },
  });
  const total = await prisma.teamMember.count();

  if (existing.length !== orderedIds.length || total !== orderedIds.length) {
    throw new ConflictError(
      `The team list has changed since it was loaded (expected ${total} members, received ${orderedIds.length}). Reload and try again.`
    );
  }

  // Renumber by array position, one transaction. No unique constraint on
  // sortOrder, so no two-phase renumber is needed (same as reorderFaqs).
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.teamMember.update({ where: { id }, data: { sortOrder: index } })
    )
  );

  logger.info({ orderedIds }, "Team members reordered");

  return prisma.teamMember.findMany({ orderBy: TEAM_MEMBER_ORDER_BY });
}
