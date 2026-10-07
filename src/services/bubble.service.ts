import { prisma } from "../lib/prisma.js";
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from "../utils/errors.js";
import { BUBBLE_BOUND_EPSILON } from "../config/generation.js";
import { logger } from "../lib/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { CreateBubbleInput, UpdateBubbleInput  } from "../validators/bubble.schema.js";

export async function createBubble(pageId: string, input: CreateBubbleInput) {
  const page = await prisma.page.findUnique({ where: { id: pageId } });

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  const data: Prisma.BubbleCreateInput = {
    page: { connect: { id: pageId } },
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    dialogue: input.dialogue,
    fontSize: input.fontSize,
    fontColor: input.fontColor,
    nameColor: input.nameColor,
    textAlign: input.textAlign,
    textVerticalAlign: input.textVerticalAlign,
    textCase: input.textCase,
    sortOrder: input.sortOrder,
  };

  if (input.fontId !== undefined) {
    data.font = { connect: { id: input.fontId } };
  }

  const bubble = await prisma.bubble.create({ data });

  logger.info(
    { pageId, bubbleId: bubble.id },
    "Bubble created successfully"
  );

  return bubble;
}


export async function listPageBubbles(pageId: string) {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true },
  });

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  const bubbles = await prisma.bubble.findMany({
    where: { pageId },
    orderBy: { sortOrder: "asc" },
    include: {
      font: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  logger.info({ pageId, bubbleCount: bubbles.length }, "Listed page bubbles");

  return bubbles;
}

export async function updateBubble(bubbleId: string, input: UpdateBubbleInput) {
  const bubble = await prisma.bubble.findUnique({
    where: { id: bubbleId },
    include: {
      page: {
        select: { comicId: true },
      },
    },
  });

  if (!bubble) {
    throw new NotFoundError("Bubble not found");
  }

  // If fontId is provided and not null, verify the font belongs to the same comic
  if (input.fontId !== undefined && input.fontId !== null) {
    const font = await prisma.font.findUnique({
      where: { id: input.fontId },
    });

    if (!font) {
      throw new NotFoundError("Font not found");
    }

    if (font.comicId !== bubble.page.comicId) {
      throw new ConflictError(
        "Font does not belong to the same comic as this bubble"
      );
    }
  }

  const data: Prisma.BubbleUpdateInput = {};
  if (input.x !== undefined) data.x = input.x;
  if (input.y !== undefined) data.y = input.y;
  if (input.width !== undefined) data.width = input.width;
  if (input.height !== undefined) data.height = input.height;
  if (input.dialogue !== undefined) data.dialogue = input.dialogue;
  if (input.fontSize !== undefined) data.fontSize = input.fontSize;
  if (input.fontColor !== undefined) data.fontColor = input.fontColor;
  // `!== undefined`, not truthiness: null is a real value here and means
  // "reset to the text colour".
  if (input.nameColor !== undefined) data.nameColor = input.nameColor;
  if (input.textAlign !== undefined) data.textAlign = input.textAlign;
  if (input.textVerticalAlign !== undefined)
    data.textVerticalAlign = input.textVerticalAlign;
  if (input.textCase !== undefined) data.textCase = input.textCase;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  // Handle fontId separately — it's a relation, not a plain field
  if (input.fontId !== undefined) {
    if (input.fontId === null) {
      data.font = { disconnect: true };
    } else {
      data.font = { connect: { id: input.fontId } };
    }
  }

  // The bounds cross-check can't live in Zod for a partial update — a body
  // containing only `x` gives Zod no `width` to add it to. Merge the incoming
  // values over the stored ones and validate the resulting rectangle.
  const merged = {
    x: input.x ?? bubble.x,
    y: input.y ?? bubble.y,
    width: input.width ?? bubble.width,
    height: input.height ?? bubble.height,
  };

  if (merged.x + merged.width > 1 + BUBBLE_BOUND_EPSILON) {
    throw new ValidationError(
      "Bubble extends past the right edge of the artwork"
    );
  }

  if (merged.y + merged.height > 1 + BUBBLE_BOUND_EPSILON) {
    throw new ValidationError(
      "Bubble extends past the bottom edge of the artwork"
    );
  }

  const updated = await prisma.bubble.update({
    where: { id: bubbleId },
    data,
    include: {
      font: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  logger.info(
    { bubbleId, pageId: bubble.pageId, fields: Object.keys(data) },
    "Bubble updated"
  );

  return updated;
}

export async function deleteBubble(bubbleId: string) {
  const bubble = await prisma.bubble.findUnique({
    where: { id: bubbleId },
  });

  if (!bubble) {
    throw new NotFoundError("Bubble not found");
  }

  await prisma.bubble.delete({
    where: { id: bubbleId },
  });

  logger.info(
    { bubbleId, pageId: bubble.pageId },
    "Bubble deleted"
  );
}