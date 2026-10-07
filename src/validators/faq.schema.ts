import { z } from "zod";

const faqPlacementEnum = z.enum(["HOME", "COMIC"], {
  message: "placement must be HOME or COMIC",
});

export const createFaqSchema = z.object({
  placement: faqPlacementEnum,
  question: z.string().trim().min(1, "Question is required"),
  answer: z.string().trim().min(1, "Answer is required"),
});

export const updateFaqSchema = z
  .object({
    placement: faqPlacementEnum.optional(),
    question: z.string().trim().min(1, "Question cannot be empty").optional(),
    answer: z.string().trim().min(1, "Answer cannot be empty").optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

export const reorderFaqsSchema = z.object({
  orderedIds: z
    .array(z.string().uuid())
    .min(1, "orderedIds cannot be empty")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds cannot contain duplicates",
    }),
});

// Query schemas — parsed manually in the controller, there is no validateQuery middleware.
export const publicFaqQuerySchema = z.object({
  placement: faqPlacementEnum,
});

export const adminFaqQuerySchema = z.object({
  placement: faqPlacementEnum.optional(),
});
