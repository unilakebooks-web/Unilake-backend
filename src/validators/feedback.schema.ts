import { z } from "zod";

// Contact details are deliberately NOT collected. `z.object` strips unknown
// keys, so a stale client still POSTing `email`/`phone` is accepted and those
// fields are discarded — never rejected, and never written.
export const createFeedbackSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  message: z.string().trim().min(1, "Message is required"),
});

export const feedbackFilterQuerySchema = z.object({
  status: z
    .enum(["OPEN", "VIEWED", "RESOLVED", "DISMISSED"], {
      message: "Invalid status. Must be OPEN, VIEWED, RESOLVED, or DISMISSED.",
    })
    .optional(),
});

export const updateFeedbackStatusSchema = z.object({
  status: z.enum(["OPEN", "VIEWED", "RESOLVED", "DISMISSED"], {
    message: "Status must be OPEN, VIEWED, RESOLVED, or DISMISSED",
  }),
});