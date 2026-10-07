import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

export async function createAnnouncement(data: { message: string }) {
  const lastAnnouncement = await prisma.announcementBar.findFirst({
    orderBy: { sortOrder: 'desc' },
  });

  const nextSortOrder = lastAnnouncement ? lastAnnouncement.sortOrder + 1 : 0;

  const announcement = await prisma.announcementBar.create({
    data: {
      message: data.message,
      sortOrder: nextSortOrder,
    },
  });

  logger.info({ announcementId: announcement.id }, 'Announcement created');

  return announcement;
}




export async function updateAnnouncement(
  id: string,
  data: { message?: string }
) {
  const existing = await prisma.announcementBar.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError('Announcement not found');
  }

  // exactOptionalPropertyTypes-safe: build the update object field-by-field,
  // never pass the raw Zod-optional object straight to Prisma.
  const updateData: { message?: string } = {};

  if (data.message !== undefined) {
    updateData.message = data.message;
  }

  const updated = await prisma.announcementBar.update({
    where: { id },
    data: updateData,
  });

  logger.info({ announcementId: id }, 'Announcement updated');

  return updated;
}


export async function listAnnouncements() {
  const announcements = await prisma.announcementBar.findMany({
    orderBy: { sortOrder: 'asc' },
  });

  return announcements;
}

export async function toggleAnnouncementStatus(id: string) {
  const existing = await prisma.announcementBar.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError('Announcement not found');
  }

  const updated = await prisma.announcementBar.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { announcementId: id, isActive: updated.isActive },
    'Announcement status toggled'
  );

  return updated;
}



export async function reorderAnnouncements(orderedIds: string[]) {
  const existing = await prisma.announcementBar.findMany({
    where: { id: { in: orderedIds } },
    select: { id: true },
  });

  if (existing.length !== orderedIds.length) {
    throw new ValidationError('One or more announcement IDs do not exist');
  }


  const updates = orderedIds.map((id, index) =>
    prisma.announcementBar.update({
      where: { id },
      data: { sortOrder: index },
    })
  );

  await prisma.$transaction(updates);

  logger.info({ orderedIds }, 'Announcements reordered');

  return prisma.announcementBar.findMany({
    orderBy: { sortOrder: 'asc' },
  });
}

export async function deleteAnnouncement(id: string) {
  const existing = await prisma.announcementBar.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError('Announcement not found');
  }

  await prisma.announcementBar.delete({ where: { id } });

  logger.info({ announcementId: id }, 'Announcement deleted');
}

export async function getActiveAnnouncements() {
  const announcements = await prisma.announcementBar.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return announcements;
}