import { prisma } from "../lib/prisma.js";
import { ConflictError } from "../utils/errors.js";

// A retired comic (feature 6, R6) keeps its row so orders, bills and sessions still read it, but nothing may change
// it any more: its files are being, or have been, deleted. One shared check, called by every admin write that is
// reached by a comic, page, bubble, font or fact id, and by sample creation.

export const RETIRED_COMIC_MESSAGE =
  "This comic was retired and can no longer be changed.";

export async function assertComicNotRetired(comicId: string): Promise<void> {
  const comic = await prisma.comic.findUnique({
    where: { id: comicId },
    select: { retiredAt: true },
  });
  if (comic?.retiredAt) throw new ConflictError(RETIRED_COMIC_MESSAGE);
}

export async function assertPageComicNotRetired(pageId: string): Promise<void> {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { comic: { select: { retiredAt: true } } },
  });
  if (page?.comic.retiredAt) throw new ConflictError(RETIRED_COMIC_MESSAGE);
}

export async function assertBubbleComicNotRetired(
  bubbleId: string
): Promise<void> {
  const bubble = await prisma.bubble.findUnique({
    where: { id: bubbleId },
    select: { page: { select: { comic: { select: { retiredAt: true } } } } },
  });
  if (bubble?.page.comic.retiredAt)
    throw new ConflictError(RETIRED_COMIC_MESSAGE);
}

export async function assertFontComicNotRetired(fontId: string): Promise<void> {
  const font = await prisma.font.findUnique({
    where: { id: fontId },
    select: { comic: { select: { retiredAt: true } } },
  });
  if (font?.comic.retiredAt) throw new ConflictError(RETIRED_COMIC_MESSAGE);
}

export async function assertFactComicNotRetired(factId: string): Promise<void> {
  const fact = await prisma.comicFact.findUnique({
    where: { id: factId },
    select: { comic: { select: { retiredAt: true } } },
  });
  if (fact?.comic.retiredAt) throw new ConflictError(RETIRED_COMIC_MESSAGE);
}
