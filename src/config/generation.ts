export const MAX_VARIANTS_BEFORE_PAYMENT = 3;
export const MAX_VARIANTS_AFTER_PAYMENT = 8;

// Per-page generation tunables. Bounds are safe ranges for the Lightning LoRA
// (which is trained for CFG=1 and 2–6 steps). Going outside these can produce
// degraded output — enforced in Zod, not in the worker.
export const DEFAULT_STEPS = 3;
export const MIN_STEPS = 1;
export const MAX_STEPS = 8;

export const DEFAULT_CFG = 1.0;
export const MIN_CFG = 1.0;
export const MAX_CFG = 3.0;

// Bubble geometry is stored as normalized 0–1 fractions of the artwork, never
// pixels. Frontend derives them by division, so a rectangle dragged flush to an
// edge can land on 1.0000000000000002 — this tolerance keeps that valid.
export const BUBBLE_BOUND_EPSILON = 0.0001;

// Bubble.fontSize is likewise a fraction — of the artwork's HEIGHT.
// Rendered size = fontSize * artworkHeight. Default 0.02 ≈ 31px on a
// 1536px-tall page. MAX_FONT_SIZE of 0.25 is already absurdly large (~384px).
export const DEFAULT_FONT_SIZE = 0.02;
export const MIN_FONT_SIZE = 0.005;
export const MAX_FONT_SIZE = 0.25;

// Bubble.fontColor is the fill of the stamped dialogue, stored as a 6-digit hex
// string and dropped straight into the SVG `fill` by the text stamper.
//
// Exactly one canonical form is accepted: "#rrggbb", lowercased on write. No
// 3-digit shorthand, no 8-digit alpha, no CSS colour names — a single form means
// the browser's colour input, the DB value and the SVG attribute are the same
// string everywhere, with no conversion step to get wrong. Transparency, if it
// is ever wanted, belongs in a separate fill-opacity field rather than in this
// one (librsvg's 8-digit hex support is unreliable).
//
// The pattern accepts either case so a pasted "#FFAA00" is a normalisation
// concern rather than a validation error; the Zod schema lowercases after this
// check passes.
export const DEFAULT_FONT_COLOR = "#000000";
export const FONT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// Bubble text placement and casing. The three defaults below are not arbitrary:
// they are exactly what the renderer did unconditionally before these fields
// existed (centred horizontally, centred vertically, text drawn as typed), so
// every bubble created before the migration keeps rendering identically.
//
// Values are the Prisma enums TextAlign / TextVerticalAlign / TextCase. Kept
// here as plain literals — same as every other default in this file — so the
// Zod schemas have one import site and the constants stay readable.
export const TEXT_ALIGNS = ["LEFT", "CENTER", "RIGHT"] as const;
export const TEXT_VERTICAL_ALIGNS = ["TOP", "MIDDLE", "BOTTOM"] as const;
export const TEXT_CASES = ["AS_TYPED", "UPPERCASE", "LOWERCASE"] as const;

export const DEFAULT_TEXT_ALIGN = "CENTER";
export const DEFAULT_TEXT_VERTICAL_ALIGN = "MIDDLE";
export const DEFAULT_TEXT_CASE = "AS_TYPED";