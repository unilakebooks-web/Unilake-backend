import { z } from "zod";
import { MAX_SAMPLE_PAGES } from "../config/sample.js";

// ⚠️ The admin screen repeats the page limit, name length and age range (frontend
// components/admin/sample/sampleConfig.ts and sampleFormSchema.ts).
export const createSampleBodySchema = z.object({
  comicId: z.string().uuid("Invalid comic ID"),
  childName: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(50, "At most 50 characters"),
  age: z
    .number()
    .int("Enter a whole number")
    .min(0, "At least 0")
    .max(18, "At most 18"),
  // A sample is a boy or a girl book; "THEY" is for customers who choose it.
  pronounKey: z.enum(["HE", "SHE"]),
  pageIds: z
    .array(z.string().uuid("Invalid page ID"))
    .min(1, "Choose at least one page")
    .max(MAX_SAMPLE_PAGES, `Choose at most ${MAX_SAMPLE_PAGES} pages`),
});

export type CreateSampleInput = z.infer<typeof createSampleBodySchema>;

export const sampleSessionParamsSchema = z.object({
  sessionId: z.string().uuid("Invalid sample ID format"),
});

export const sampleSelectionsBodySchema = z.object({
  // One chosen version per page; the service checks every id against the session.
  selections: z
    .array(
      z.object({
        pageId: z.string().uuid("Invalid page ID"),
        pageVersionId: z.string().uuid("Invalid page version ID"),
      })
    )
    .min(1, "Choose at least one page")
    .max(MAX_SAMPLE_PAGES, `Choose at most ${MAX_SAMPLE_PAGES} pages`),
});

export type SampleSelectionsInput = z.infer<typeof sampleSelectionsBodySchema>;
