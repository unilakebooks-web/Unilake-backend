import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { NotFoundError } from "../utils/errors.js";

    
export async function createFeedback(data: {
  name: string;
  message: string;
}) {
  const feedback = await prisma.feedback.create({
    data: {
      name: data.name,
      message: data.message,
    },
  });

  logger.info({ feedbackId: feedback.id }, "Feedback submitted");

  return feedback;
}

export async function getAllFeedbacks(status?: "OPEN" | "VIEWED" | "RESOLVED" | "DISMISSED") {
  const feedbacks = await prisma.feedback.findMany({
    where: {
      ...(status !== undefined && { status }),
    },
    orderBy: { createdAt: "desc" },
  });

  return feedbacks;
}


export async function updateFeedbackStatus(
  id: string,
  status: "OPEN" | "VIEWED" | "RESOLVED" | "DISMISSED"
) {
  const existing = await prisma.feedback.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Feedback not found");
  }

  const updated = await prisma.feedback.update({
    where: { id },
    data: { status },
  });

  logger.info({ feedbackId: id, status: updated.status }, "Feedback status updated");

  return updated;
}


export async function deleteFeedback(id: string) {
  const existing = await prisma.feedback.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Feedback not found");
  }

  await prisma.feedback.delete({ where: { id } });

  logger.info({ feedbackId: id }, "Feedback deleted");
}