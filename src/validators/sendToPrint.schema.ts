import { z } from "zod";

// params - sessionId in the URL must be a valid UUID

export const sendToPrintParamsSchema = z.object({
    sessionId : z.string().uuid("Invalid Session ID")
})

/**
 * Body — the customer's variant picks, one entry per page.
 *
 * Validation done here (fast, before hitting DB):
 *  - `selections` is a non-empty array
 *  - each entry has a positive integer `pageNumber` and a non-negative
 *    integer `variantIndex`
 *  - no duplicate `pageNumber` values in the array
 *
 * Validation done in the service (needs DB):
 *  - selections.length matches Comic.pageCount
 *  - every {pageNumber, variantIndex} pair points to a real PageVersion
 *  - every selected PageVersion is SD_READY
 *  - no in-flight PageVersion exists for this session
 */

export const sendToPrintBodySchema = z.object({
  selections: z
    .array(
      z.object({
        pageNumber: z
          .number()
          .int("pageNumber must be an integer")
          .positive("pageNumber must be >= 1"),
        variantIndex: z
          .number()
          .int("variantIndex must be an integer")
          .nonnegative("variantIndex must be >= 0"),
      })
    )
    .min(1, "At least one selection is required")
    .refine(
      (arr) => {
        const seen = new Set<number>();
        for (const s of arr) {
          if (seen.has(s.pageNumber)) return false;
          seen.add(s.pageNumber);
        }
        return true;
      },
      { message: "Duplicate pageNumber in selections" }
    ),
});

export type SendToPrintInput = z.infer<typeof sendToPrintBodySchema>;