import { z } from "zod";

/**
 * Optional SEO text (share title, share description, alt text, image key).
 *
 * Trimmed, length-capped, and an empty or blank string is stored as null, the
 * same as sending null: the admin form sends "" for a cleared box and that must
 * clear the column, not save an empty string that a page would then render as
 * an empty title or alt. Omitted = unchanged.
 *
 * The cap is checked on the trimmed text, so a value of spaces clears the
 * field instead of failing.
 */
export const seoText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

/** Alt text for an image the admin uploads (D-139). Never HTML. */
export const altText = seoText(200, "Alt text");
