import { z } from "zod";
import {
  BUBBLE_BOUND_EPSILON,
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  DEFAULT_FONT_COLOR,
  FONT_COLOR_PATTERN,
  TEXT_ALIGNS,
  TEXT_VERTICAL_ALIGNS,
  TEXT_CASES,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_VERTICAL_ALIGN,
  DEFAULT_TEXT_CASE,
} from "../config/generation.js";

// Regex FIRST, lowercase SECOND. Validating before transforming means a pasted
// "#FFAA00" is accepted and normalised rather than reported as malformed, while
// genuinely bad input still fails against the original string the client sent.
//
// A factory rather than one schema so the error names the field that failed —
// fontColor and nameColor share the rule but a bad nameColor must not report
// itself as "fontColor must be…".
export function hexColorSchema(fieldName: string) {
  return z
    .string()
    .trim()
    .regex(
      FONT_COLOR_PATTERN,
      `${fieldName} must be a 6-digit hex colour like "#1a1a1a" — shorthand, alpha and colour names are not accepted`
    )
    .transform((value) => value.toLowerCase());
}

export const fontColorSchema = hexColorSchema("fontColor");

/**
 * The geometry and styling fields shared by every schema that describes a
 * bubble — currently createBubbleSchema and the preview-stamp endpoint.
 *
 * Exported as raw field definitions rather than a schema so callers can spread
 * them into their own z.object() and add what they need. Re-typing these in a
 * second file is how the preview would start accepting geometry the real create
 * endpoint rejects, which would make the preview lie.
 */
export const bubbleGeometryFields = {
  x: z
    .number()
    .min(0, "x must be a 0–1 fraction of the artwork width")
    .max(1, "x must be a 0–1 fraction of the artwork width"),
  y: z
    .number()
    .min(0, "y must be a 0–1 fraction of the artwork height")
    .max(1, "y must be a 0–1 fraction of the artwork height"),
  width: z
    .number()
    .gt(0, "width must be greater than 0")
    .max(1, "width cannot exceed the full artwork width"),
  height: z
    .number()
    .gt(0, "height must be greater than 0")
    .max(1, "height cannot exceed the full artwork height"),
  fontSize: z
    .number()
    .min(MIN_FONT_SIZE, `fontSize must be at least ${MIN_FONT_SIZE}`)
    .max(MAX_FONT_SIZE, `fontSize cannot exceed ${MAX_FONT_SIZE}`)
    .default(DEFAULT_FONT_SIZE),
  fontColor: fontColorSchema.default(DEFAULT_FONT_COLOR),
  // Colour for the {name} part of the dialogue only. null = same as fontColor,
  // which is also what every bubble created before this field existed has.
  nameColor: hexColorSchema("nameColor").nullable().default(null),
  textAlign: z.enum(TEXT_ALIGNS).default(DEFAULT_TEXT_ALIGN),
  textVerticalAlign: z
    .enum(TEXT_VERTICAL_ALIGNS)
    .default(DEFAULT_TEXT_VERTICAL_ALIGN),
  textCase: z.enum(TEXT_CASES).default(DEFAULT_TEXT_CASE),
};

/**
 * The two bounds checks that need the whole rectangle at once: x and width are
 * each individually valid but can still overflow together.
 */
export function refineBubbleBounds<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine(
      (data: any) => data.x + data.width <= 1 + BUBBLE_BOUND_EPSILON,
      {
        message: "Bubble extends past the right edge of the artwork",
        path: ["width"],
      }
    )
    .refine(
      (data: any) => data.y + data.height <= 1 + BUBBLE_BOUND_EPSILON,
      {
        message: "Bubble extends past the bottom edge of the artwork",
        path: ["height"],
      }
    );
}

// Bubble geometry is normalized to 0–1 fractions of the artwork, never pixels.
// x/y is the top-left corner; the whole rectangle must fit inside the page.
export const createBubbleSchema = refineBubbleBounds(
  z.object({
    // Geometry, font size, colour, placement and casing — shared with the
    // preview endpoint so the two can never disagree about what is valid.
    ...bubbleGeometryFields,
    dialogue: z.string().min(1),
    fontId: z.string().uuid().optional(),
    sortOrder: z.number().int().default(0),
  })
);

// No sum refine here: PATCH is partial, so Zod may only see `x` and have no idea
// what `width` is. That cross-check lives in bubble.service.updateBubble(),
// where the existing row is available to merge against.
export const updateBubbleSchema = z
  .object({
    x: z
      .number()
      .min(0, "x must be a 0–1 fraction of the artwork width")
      .max(1, "x must be a 0–1 fraction of the artwork width")
      .optional(),
    y: z
      .number()
      .min(0, "y must be a 0–1 fraction of the artwork height")
      .max(1, "y must be a 0–1 fraction of the artwork height")
      .optional(),
    width: z
      .number()
      .gt(0, "width must be greater than 0")
      .max(1, "width cannot exceed the full artwork width")
      .optional(),
    height: z
      .number()
      .gt(0, "height must be greater than 0")
      .max(1, "height cannot exceed the full artwork height")
      .optional(),
    dialogue: z.string().min(1).optional(),
    fontId: z.string().uuid().nullable().optional(),
    fontSize: z
      .number()
      .min(MIN_FONT_SIZE, `fontSize must be at least ${MIN_FONT_SIZE}`)
      .max(MAX_FONT_SIZE, `fontSize cannot exceed ${MAX_FONT_SIZE}`)
      .optional(),
    // Optional, never nullable: the column is NOT NULL, so "clear the colour"
    // is not a thing a client can express — it sets #000000 instead.
    fontColor: fontColorSchema.optional(),
    // Unlike fontColor, nameColor IS nullable: null is how the client says
    // "same as the text colour" (the column is nullable for exactly that).
    // Omitted = unchanged, null = reset, "#rrggbb" = set.
    nameColor: hexColorSchema("nameColor").nullable().optional(),
    // Same rule as fontColor: optional, never nullable. These columns are NOT
    // NULL, so "unset the alignment" means sending CENTER, not null.
    textAlign: z.enum(TEXT_ALIGNS).optional(),
    textVerticalAlign: z.enum(TEXT_VERTICAL_ALIGNS).optional(),
    textCase: z.enum(TEXT_CASES).optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type CreateBubbleInput = z.infer<typeof createBubbleSchema>;
export type UpdateBubbleInput = z.infer<typeof updateBubbleSchema>;