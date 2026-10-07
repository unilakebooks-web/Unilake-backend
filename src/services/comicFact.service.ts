import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { NotFoundError } from "../utils/errors.js";
import type { ComicFactPlacement } from "../generated/prisma/enums.js";

/**
 * Rotating facts shown on the generation screens, scoped to one comic.
 *
 * Purely decorative: a comic with no facts publishes and generates exactly as
 * one with twenty. Nothing here gates anything, and there is no R2 cleanup to
 * do because a fact is only ever a line of text.
 *
 * Deletion of the parent comic is handled by the database (onDelete: Cascade),
 * not here.
 */

// Insertion order. Display order is decided in the browser — the list is
// shuffled per visit — so this exists purely so the ADMIN list does not
// reshuffle itself every time the page is refreshed.
const FACT_ORDER_BY = { createdAt: "asc" as const };

export async function listComicFactsAdmin(
  comicId: string,
  placement?: ComicFactPlacement
) {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  // Inactive rows included on purpose: the admin needs to see what they have
  // switched off in order to switch it back on.
  return prisma.comicFact.findMany({
    where: {
      comicId,
      ...(placement !== undefined && { placement }),
    },
    orderBy: FACT_ORDER_BY,
  });
}

export async function createComicFact(
  comicId: string,
  data: { placement: ComicFactPlacement; text: string }
) {
  // Checked explicitly rather than relying on the foreign key: a bad comicId in
  // the URL should be a clean 404, not a raw P2003 constraint error.
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { id: true },
  });

  if (!comic) {
    throw new NotFoundError("Comic not found");
  }

  const fact = await prisma.comicFact.create({
    data: {
      comicId,
      placement: data.placement,
      text: data.text,
    },
  });

  logger.info(
    { factId: fact.id, comicId, placement: fact.placement },
    "Comic fact created"
  );

  return fact;
}

export async function updateComicFact(
  factId: string,
  data: { placement?: ComicFactPlacement; text?: string }
) {
  const existing = await prisma.comicFact.findUnique({ where: { id: factId } });

  if (!existing) {
    throw new NotFoundError("Fact not found");
  }

  const updated = await prisma.comicFact.update({
    where: { id: factId },
    data: {
      ...(data.placement !== undefined && { placement: data.placement }),
      ...(data.text !== undefined && { text: data.text }),
    },
  });

  logger.info({ factId, comicId: updated.comicId }, "Comic fact updated");

  return updated;
}

export async function toggleComicFactStatus(factId: string) {
  const existing = await prisma.comicFact.findUnique({ where: { id: factId } });

  if (!existing) {
    throw new NotFoundError("Fact not found");
  }

  const updated = await prisma.comicFact.update({
    where: { id: factId },
    data: { isActive: !existing.isActive },
  });

  logger.info(
    { factId, comicId: updated.comicId, isActive: updated.isActive },
    "Comic fact status toggled"
  );

  return updated;
}

export async function deleteComicFact(factId: string) {
  const existing = await prisma.comicFact.findUnique({ where: { id: factId } });

  if (!existing) {
    throw new NotFoundError("Fact not found");
  }

  await prisma.comicFact.delete({ where: { id: factId } });

  logger.info({ factId, comicId: existing.comicId }, "Comic fact deleted");
}
