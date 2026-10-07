import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import type { FaqPlacement } from "../generated/prisma/enums.js";

// createdAt breaks sortOrder ties so ordering is deterministic even when two
// concurrent creates in the same placement read the same max(sortOrder).
const FAQ_ORDER_BY = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

export async function createFaq(data: {
  placement: FaqPlacement;
  question: string;
  answer: string;
}) {
  const last = await prisma.faq.findFirst({
    where: { placement: data.placement },
    orderBy: { sortOrder: "desc" },
  });

  const sortOrder = last ? last.sortOrder + 1 : 0;

  const faq = await prisma.faq.create({
    data: {
      placement: data.placement,
      question: data.question,
      answer: data.answer,
      sortOrder,
    },
  });

  logger.info({ faqId: faq.id, placement: faq.placement }, "FAQ created");

  return faq;
}

export async function updateFaq(
  id: string,
  data: {
    placement?: FaqPlacement;
    question?: string;
    answer?: string;
  }
) {
  const existing = await prisma.faq.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("FAQ not found");
  }

  const updateData: {
    placement?: FaqPlacement;
    question?: string;
    answer?: string;
    sortOrder?: number;
  } = {};

  if (data.question !== undefined) updateData.question = data.question;
  if (data.answer !== undefined) updateData.answer = data.answer;

  // Guard on old !== new. Re-sending the CURRENT placement on every save
  // (an edit form that resends every field) must be a no-op, not a jump to
  // the bottom of the list — same bug class as re-sending an unchanged
  // imageKey in updateTeamMember.
  if (data.placement !== undefined && data.placement !== existing.placement) {
    updateData.placement = data.placement;

    const last = await prisma.faq.findFirst({
      where: { placement: data.placement },
      orderBy: { sortOrder: "desc" },
    });
    updateData.sortOrder = last ? last.sortOrder + 1 : 0;
  }

  const updated = await prisma.faq.update({
    where: { id },
    data: updateData,
  });

  logger.info(
    { faqId: id, updatedFields: Object.keys(updateData) },
    "FAQ updated"
  );

  return updated;
}

export async function listFaqs(placement?: FaqPlacement) {
  const faqs = await prisma.faq.findMany({
    where: placement !== undefined ? { placement } : undefined,
    orderBy: FAQ_ORDER_BY,
  });

  return faqs;
}

export async function getActiveFaqs(placement: FaqPlacement) {
  const faqs = await prisma.faq.findMany({
    where: { placement, isActive: true },
    orderBy: FAQ_ORDER_BY,
  });

  return faqs;
}

export async function toggleFaqStatus(id: string) {
  const existing = await prisma.faq.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("FAQ not found");
  }

  const updated = await prisma.faq.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  logger.info({ faqId: id, isActive: updated.isActive }, "FAQ status toggled");

  return updated;
}

export async function reorderFaqs(orderedIds: string[]) {
  const rows = await prisma.faq.findMany({
    where: { id: { in: orderedIds } },
    select: { id: true, placement: true },
  });

  // 1. every ID must exist
  if (rows.length !== orderedIds.length) {
    throw new ValidationError("One or more FAQ IDs do not exist");
  }

  // 2. they must all belong to ONE placement — this is where the placement
  // for the reorder comes from; the client never sends it.
  const placements = new Set(rows.map((r) => r.placement));
  if (placements.size > 1) {
    throw new ValidationError(
      "All FAQs in a reorder must belong to the same placement"
    );
  }

  const firstRow = rows[0];
  if (!firstRow) {
    // Unreachable: reorderFaqsSchema enforces orderedIds.min(1), and check 1
    // above already guarantees rows.length === orderedIds.length >= 1.
    throw new ValidationError("orderedIds cannot be empty");
  }
  const placement = firstRow.placement;

  // 3. must be the COMPLETE list for that placement, including inactive rows —
  // the admin table shows both, so the drag list must contain both.
  const total = await prisma.faq.count({ where: { placement } });
  if (total !== orderedIds.length) {
    throw new ValidationError(
      `Reorder must include every FAQ for ${placement} (expected ${total}, received ${orderedIds.length})`
    );
  }

  // 4. renumber by array position, one transaction. No unique constraint on
  // sortOrder, so no two-phase negative renumber is needed.
  const updates = orderedIds.map((id, index) =>
    prisma.faq.update({
      where: { id },
      data: { sortOrder: index },
    })
  );

  await prisma.$transaction(updates);

  logger.info({ placement, orderedIds }, "FAQs reordered");

  return prisma.faq.findMany({
    where: { placement },
    orderBy: FAQ_ORDER_BY,
  });
}

export async function deleteFaq(id: string) {
  const existing = await prisma.faq.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("FAQ not found");
  }

  await prisma.faq.delete({ where: { id } });

  logger.info({ faqId: id }, "FAQ deleted");
}
