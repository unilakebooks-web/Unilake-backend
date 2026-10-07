// Sharp text renderer.
//
// ⚠️ COPIED IN THE FRONTEND: frontend/lib/bubbleLayout.ts repeats this file's
// layout (casing, name colour, wrap, fit, alignment) so the admin canvas shows
// exactly what prints. Change layout here → change it there too.
//
// ⚠️ READ THIS BEFORE CHANGING HOW TEXT IS DRAWN.
//
// Text is rendered by converting glyphs to SVG <path> outlines with opentype.js,
// NOT by emitting SVG <text> with a font-family.
//
// Why: Sharp renders SVG through librsvg, which delegates ALL font lookup to
// fontconfig — meaning it can only use fonts INSTALLED ON THE MACHINE. An
// @font-face rule with an embedded base64 data URI is parsed and silently
// discarded. The previous implementation did exactly that, which produced two
// different failures from one bug:
//
//   • locally (Windows): fontconfig substituted an arbitrary installed system
//     font, so text appeared — but never in the comic's actual uploaded font.
//   • in production (node:22-bookworm-slim): the image ships with ZERO fonts,
//     so there was nothing to substitute and dialogue rendered blank.
//
// Neither case errored. Sharp treats an unresolvable font as empty output and
// reports success, so blank pages sailed through to SD_READY.
//
// Converting to paths removes fontconfig from the picture entirely: a <path> is
// pure geometry and renders identically on every machine, with no fonts
// installed anywhere. It also gives us real glyph metrics, so wrapping and
// auto-shrink are measured rather than estimated.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ SECOND THING TO KNOW: not every valid font can be SHAPED by opentype.js.
//
// Asking opentype.js to measure or draw a string runs its text-shaping engine
// first, which applies the font's OpenType feature tables (ligatures, glyph
// composition, and so on). That engine implements only a subset of the ways
// those tables can legally be encoded, and when it meets an encoding it does
// not implement it THROWS instead of skipping the rule.
//
// A real font uploaded in production did exactly that:
//   "substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported"
// It crashed every page it appeared on, three BullMQ attempts each, because a
// deterministic library gap cannot be retried away. The font itself was fine —
// it parsed cleanly and contained every glyph the dialogue needed. Only the
// shaping step failed.
//
// There is no option to disable this. The composition feature is switched on
// unconditionally inside the library and queried under the "default" script,
// so no combination of render options avoids it.
//
// So: we probe each font ONCE at load time and, if shaping throws, fall back to
// laying the text out one glyph at a time (see layoutUnshaped). The fallback
// gives up ligatures and contextual substitution for that one font — invisible
// for Latin comic dialogue — and keeps kerning, metrics and everything else.
// A page renders slightly plainer instead of not rendering at all.

import sharp, { type OverlayOptions } from "sharp";
import opentype from "opentype.js";
import { downloadFileToBuffer, getKeyFromPublicUrl } from "../../../lib/r2.js";
import { logger } from "../../../lib/logger.js";
import { ValidationError } from "../../../utils/errors.js";
import { substituteTokensToSegments, type DialogueSegment } from "./tokens.js";
import { MIN_FONT_SIZE, FONT_COLOR_PATTERN } from "../../../config/generation.js";
import type {
  Page,
  Bubble,
  Font,
  PronounKey,
  TextAlign,
  TextVerticalAlign,
  TextCase,
} from "../../../generated/prisma/client.js";

type BubbleWithFont = Bubble & { font: Font | null };

/**
 * A parsed font plus what we learned about how it can safely be rendered.
 *
 * `canShape` is decided ONCE, at load time (see detectShapingSupport), and every
 * measure and draw call downstream reads that flag rather than discovering the
 * answer for itself. Keeping the decision in one place is what guarantees
 * measuring and drawing stay in lockstep: a line measured with the shaper is
 * always drawn with the shaper, and a line measured without it is always drawn
 * without it. If those two ever disagreed, every line would be centred against
 * a width that doesn't match the glyphs actually painted.
 */
type LoadedFont = {
  font: opentype.Font;
  /** Display name, for error messages. */
  name: string;
  /** False when this font's own feature tables crash opentype.js's shaper. */
  canShape: boolean;
};

type StampTextParams = {
  page: Page;
  bubbles: BubbleWithFont[];
  childName: string;
  pronounKey: PronounKey;
};

/**
 * Extra leading applied on top of the font's OWN natural line height
 * (ascender − descender). Unlike the old flat 1.2 × font-size, this respects
 * fonts that are naturally tall or tight, so line spacing looks consistent
 * across different uploaded fonts.
 */
const LINE_HEIGHT_FACTOR = 1.15;

/** Decimal places kept in emitted SVG path data. 2 is visually lossless at print size. */
const PATH_PRECISION = 2;

const PATH_ROUNDING_FACTOR = 10 ** PATH_PRECISION;

// ============================================================
// SVG PATH DATA (our own writer — do NOT use opentype's toPathData)
// ============================================================
//
// ⚠️ opentype.js's Path.toPathData() can emit "NaN" for perfectly valid glyphs.
//
// Its rounding helper builds a string out of the coordinate's fractional part
// and appends "e+2" to it. Float drift routinely produces coordinates like
// 180.00000000000003, whose fractional part stringifies in exponent form
// ("2.842170943040401e-14"), so the helper parses "2.84...e-14e+2" -> NaN.
//
// librsvg stops drawing a path at the first unparseable number, so every glyph
// after that point — including all later lines, since a bubble is one <path> —
// silently vanished. Sharp reported success. Whether a given coordinate drifts
// depends on the exact font size and pen position, so the bug looked random:
// TT Masters at 37px rendered fully, at 40px it printed "WOULD LIKE T".
//
// Rounding here is pure arithmetic on numbers — nothing is ever parsed back
// from a string — so exponent notation cannot occur. After rounding to 2
// decimals the smallest non-zero magnitude is 0.01, which String() never
// writes in exponent form.

/**
 * One coordinate, rounded and serialised. Throws on NaN/Infinity rather than
 * writing it: a non-finite value would truncate the path exactly like the bug
 * above, so it must fail the render instead of silently dropping text.
 */
function formatCoord(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ValidationError(
      `Text rendering produced an invalid coordinate (${value}). ` +
        `The bubble cannot be drawn safely.`,
    );
  }

  const rounded = Math.round(value * PATH_ROUNDING_FACTOR) / PATH_ROUNDING_FACTOR;

  // -0 would stringify as "0" anyway, but be explicit: "-0" must never appear.
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Serialise opentype path commands to SVG path data. Replaces Path.toPathData. */
function commandsToPathData(commands: opentype.PathCommand[]): string {
  const f = formatCoord;

  return commands
    .map((command) => {
      switch (command.type) {
        case "M":
          return `M${f(command.x)} ${f(command.y)}`;
        case "L":
          return `L${f(command.x)} ${f(command.y)}`;
        case "C":
          return `C${f(command.x1)} ${f(command.y1)} ${f(command.x2)} ${f(command.y2)} ${f(command.x)} ${f(command.y)}`;
        case "Q":
          return `Q${f(command.x1)} ${f(command.y1)} ${f(command.x)} ${f(command.y)}`;
        case "Z":
          return "Z";
        default:
          return "";
      }
    })
    .join("");
}

/**
 * Last line of defence before the SVG reaches Sharp.
 *
 * Path data may contain only the command letters we emit, digits, dots, minus
 * signs and spaces. Anything else — "NaN", "Infinity", "e" notation — means
 * librsvg would stop drawing partway and text would silently go missing from a
 * printed book. Fail the render loudly instead, same posture as the missing-font
 * and missing-glyph guards: the admin preview shows the error, and a real
 * generation job fails rather than shipping truncated dialogue.
 */
const SAFE_PATH_DATA = /^[MLCQZ0-9. -]*$/;

function assertSafePathData(pathData: string, bubbleId: string): void {
  if (SAFE_PATH_DATA.test(pathData)) return;

  const badIndex = pathData.search(/[^MLCQZ0-9. -]/);

  logger.error(
    {
      bubbleId,
      excerpt: pathData.slice(Math.max(0, badIndex - 40), badIndex + 40),
    },
    "Refusing to render bubble — SVG path data contains an invalid value",
  );

  throw new ValidationError(
    `Bubble ${bubbleId} could not be rendered safely: its text outline contains an ` +
      `invalid value, so part of the dialogue would be missing from the page.`,
  );
}

// ============================================================
// FONT LOADING
// ============================================================

/**
 * Node Buffers are views into a larger pooled ArrayBuffer, so passing
 * `buffer.buffer` straight to opentype.js would hand it unrelated memory.
 * Slice to this view's exact bounds.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/**
 * Parse a downloaded font file into an opentype.js Font.
 *
 * Throws with an actionable message rather than letting a raw parser error
 * surface — the admin who uploaded the file is the one who has to fix it.
 *
 * Supports TTF, OTF and WOFF. WOFF2 is NOT supported (it needs a Brotli
 * decompressor opentype.js does not bundle) even though the upload validator
 * currently accepts the extension.
 */
function parseFont(fontBuffer: Buffer, fontName: string, fontKey: string): opentype.Font {
  try {
    return opentype.parse(toArrayBuffer(fontBuffer));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    if (fontKey.endsWith(".woff2") || detail.includes("WOFF2")) {
      throw new ValidationError(
        `Font "${fontName}" (${fontKey}) is WOFF2, which cannot be used for page rendering. ` +
          `Re-upload this font as .ttf or .otf.`,
      );
    }

    throw new ValidationError(
      `Font "${fontName}" (${fontKey}) could not be parsed and cannot be used for page rendering. ` +
        `Re-upload a valid .ttf or .otf file. Parser said: ${detail}`,
    );
  }
}

/**
 * Text used to probe whether a font can be shaped.
 *
 * Its CONTENT is deliberately unimportant. opentype.js opens a composition
 * context for the whole string whenever it is longer than one character, and
 * the crash happens while it walks the font's lookup tables — before it ever
 * compares them against the characters. So any two-character string is a
 * complete test, and a font that shapes this shapes anything.
 *
 * A short mixed string is used anyway rather than the bare minimum, so the
 * probe stays meaningful if a future opentype.js makes the context check
 * character-dependent.
 */
const SHAPING_PROBE_TEXT = "AVa fi 1.";

/** Font size for the probe. Irrelevant to the outcome — shaping is size-independent. */
const SHAPING_PROBE_SIZE_PX = 100;

/**
 * Decide once whether this font can go through opentype.js's shaper.
 *
 * Called exactly once per font per job, straight after parsing, so the cost is
 * one measurement rather than one try/catch per line per candidate font size —
 * fitTextToBox alone would otherwise run this hundreds of times per bubble.
 *
 * Returns false rather than throwing: a font that cannot be shaped is still
 * perfectly usable through layoutUnshaped, so this is a routing decision, not
 * an error. It is logged at warn level because it is worth knowing which font
 * is degraded and why, without failing the job.
 */
function detectShapingSupport(
  font: opentype.Font,
  fontName: string,
  fontKey: string,
): boolean {
  try {
    font.getAdvanceWidth(SHAPING_PROBE_TEXT, SHAPING_PROBE_SIZE_PX);
    return true;
  } catch (err) {
    logger.warn(
      {
        fontName,
        fontKey,
        err: err instanceof Error ? err.message : String(err),
      },
      "Font cannot be shaped by opentype.js — falling back to per-glyph layout. " +
        "Ligatures and contextual substitution are skipped for this font; " +
        "kerning, metrics and glyph shapes are unaffected.",
    );
    return false;
  }
}

/**
 * Lay out `text` one glyph at a time, without the shaper.
 *
 * This is a deliberate re-implementation of opentype.js's own forEachGlyph with
 * exactly one line changed: where the library calls stringToGlyphs() — the call
 * that runs the shaper and can throw — this maps each character directly through
 * charToGlyph(). The rest (the unitsPerEm scale, advance accumulation, kerning
 * between adjacent pairs) mirrors the library's arithmetic exactly, so geometry
 * is identical for any font whose shaping would not have altered the glyph run.
 *
 * Kerning survives. font.getKerningValue() reads GPOS kerning with a fallback to
 * the legacy `kern` table; that is glyph POSITIONING, which never goes through
 * the substitution machinery that throws. Only ligatures and contextual
 * substitution are lost.
 *
 * Iterating with a spread walks whole code points rather than UTF-16 halves, so
 * characters outside the basic plane map to one glyph instead of two broken ones.
 *
 * Returns the total advance width, and invokes `onGlyph` for each glyph with its
 * pen offset relative to the start of the run — so the same walk serves both
 * measuring (ignore the callback) and drawing (use it).
 */
function layoutUnshaped(
  font: opentype.Font,
  text: string,
  fontSizePx: number,
  onGlyph?: (glyph: opentype.Glyph, penXPx: number) => void,
): number {
  const scale = fontSizePx / font.unitsPerEm;
  const glyphs = [...text].map((char) => font.charToGlyph(char));

  let penXPx = 0;

  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index]!;

    onGlyph?.(glyph, penXPx);

    // Matches the library: a glyph with no advanceWidth contributes nothing.
    if (glyph.advanceWidth) penXPx += glyph.advanceWidth * scale;

    const next = glyphs[index + 1];
    if (next) penXPx += font.getKerningValue(glyph, next) * scale;
  }

  return penXPx;
}

/**
 * Fail loudly when the font has no glyph for a character we're about to draw.
 *
 * Glyph index 0 is `.notdef`. Many fonts draw `.notdef` as an empty outline
 * (invisible) or a hollow box (tofu) — both of which would silently produce a
 * wrong page rather than an error, which is precisely the failure mode this
 * whole module was rewritten to eliminate. Whitespace is exempt: it legitimately
 * has no visible outline.
 */
function assertGlyphCoverage(font: opentype.Font, text: string, fontName: string): void {
  const missing = new Set<string>();

  for (const char of text) {
    if (/\s/.test(char)) continue;
    if (font.charToGlyphIndex(char) === 0) missing.add(char);
  }

  if (missing.size > 0) {
    const chars = [...missing].join(" ");
    throw new ValidationError(
      `Font "${fontName}" has no glyphs for: ${chars}. ` +
        `The dialogue (or the child's name) uses characters this font does not contain — ` +
        `they would render as blank or as empty boxes. Use a font that covers this text.`,
    );
  }
}

// ============================================================
// MEASUREMENT (real font metrics — no estimation)
// ============================================================

/**
 * Advance width of `text` in pixels at `fontSizePx`, kerning included.
 *
 * Routes on `canShape` so that measurement always matches what buildLinePathData
 * will actually paint — see the note on LoadedFont.
 */
/**
 * Apply a bubble's casing to its fully-substituted dialogue.
 *
 * Deliberately locale-independent (`toUpperCase`, not `toLocaleUpperCase`): the
 * server has no notion of the reader's locale, and a locale-aware transform
 * would make the same comic render differently depending on the host's
 * environment — the exact class of "works locally, wrong in the container" bug
 * this module was rewritten to eliminate.
 */
function applyTextCase(text: string, textCase: TextCase): string {
  switch (textCase) {
    case "UPPERCASE":
      return text.toUpperCase();
    case "LOWERCASE":
      return text.toLowerCase();
    case "AS_TYPED":
    default:
      return text;
  }
}

// ============================================================
// NAME-COLOUR TRACKING
// ============================================================
//
// Bubble.nameColor paints the {name} part of the dialogue in its own colour.
// Tokens are substituted before layout, so without this the renderer would no
// longer know which characters were the name. Each piece of text therefore
// carries a `nameMask`: one boolean per UTF-16 code unit of `text`, true where
// that unit came from a {name} token. `text` and `nameMask` always have the same
// length, and every slice of one is taken at the same indices from the other.
//
// Layout (wrapping, shrink-to-fit, alignment) reads `text` only, exactly as it
// did before this existed — the mask never changes a size or a line break. It
// is consulted only at the very end, to decide which colour each run is drawn in.

type StyledText = {
  text: string;
  nameMask: boolean[];
};

/**
 * Join substituted segments into one string plus its name mask, applying the
 * bubble's casing and trimming the ends.
 *
 * Casing is applied PER SEGMENT, before joining. Casing can change a string's
 * length ("ß" uppercases to "SS"), so casing the joined string afterwards would
 * shift every index after that character and misalign the mask. Per-segment
 * casing keeps each piece's mask exactly as long as its cased text. The only
 * place this can differ from casing the whole string is context-sensitive
 * lowercasing at a segment boundary (Greek final sigma) — irrelevant here.
 *
 * Trimming mirrors the old `.trim()` on the substituted dialogue: same
 * whitespace definition (trimStart/trimEnd), applied to both arrays alike.
 */
function buildStyledText(
  segments: DialogueSegment[],
  textCase: TextCase,
): StyledText {
  let text = "";
  const nameMask: boolean[] = [];

  for (const segment of segments) {
    const cased = applyTextCase(segment.text, textCase);
    text += cased;
    for (let index = 0; index < cased.length; index += 1) {
      nameMask.push(segment.isName);
    }
  }

  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;

  if (end <= start) return { text: "", nameMask: [] };

  return {
    text: text.slice(start, end),
    nameMask: nameMask.slice(start, end),
  };
}

type ColourRun = {
  text: string;
  /** Code-unit offset of this run within its line. */
  start: number;
  isName: boolean;
};

/**
 * Cut one line into maximal runs of the same colour.
 *
 * Cannot split a surrogate pair: both halves of a code point always come from
 * the same segment, so they always carry the same mask value.
 */
function splitIntoColourRuns(line: StyledText): ColourRun[] {
  const runs: ColourRun[] = [];
  let start = 0;

  for (let index = 1; index <= line.text.length; index += 1) {
    const atEnd = index === line.text.length;

    if (atEnd || line.nameMask[index] !== line.nameMask[start]) {
      runs.push({
        text: line.text.slice(start, index),
        start,
        isName: line.nameMask[start] === true,
      });
      start = index;
    }
  }

  return runs;
}

function measureWidth(loaded: LoadedFont, text: string, fontSizePx: number): number {
  return loaded.canShape
    ? loaded.font.getAdvanceWidth(text, fontSizePx)
    : layoutUnshaped(loaded.font, text, fontSizePx);
}

/**
 * SVG path data for one line of text, with its left edge at `xPx` and its
 * baseline at `baselineYPx`.
 *
 * The shaped and unshaped branches produce the same kind of output — absolute
 * glyph outlines in artwork coordinates — so the caller does not care which ran.
 * Concatenating per-glyph path data is valid SVG and matches how buildBubbleSvg
 * already joins the per-line results.
 */
function buildLinePathData(
  loaded: LoadedFont,
  line: string,
  xPx: number,
  baselineYPx: number,
  fontSizePx: number,
): string {
  // Both branches serialise through commandsToPathData, never toPathData —
  // see the note above commandsToPathData for why.
  if (loaded.canShape) {
    return commandsToPathData(
      loaded.font.getPath(line, xPx, baselineYPx, fontSizePx).commands,
    );
  }

  const glyphPaths: string[] = [];

  layoutUnshaped(loaded.font, line, fontSizePx, (glyph, penXPx) => {
    glyphPaths.push(
      commandsToPathData(
        glyph
          // Passing the font hands the glyph its own default render options, the
          // same ones Font.getPath would have applied on the shaped path.
          .getPath(xPx + penXPx, baselineYPx, fontSizePx, undefined, loaded.font)
          .commands,
      ),
    );
  });

  return glyphPaths.join(" ");
}

type LineMetrics = {
  /** Distance between consecutive baselines. */
  lineHeightPx: number;
  /** Baseline-to-top-of-ascenders. */
  ascenderPx: number;
  /** Leading added on top of the font's natural line height. */
  leadingPx: number;
};

function lineMetrics(font: opentype.Font, fontSizePx: number): LineMetrics {
  const scale = fontSizePx / font.unitsPerEm;
  const ascenderPx = font.ascender * scale;
  // descender is negative in font units, so subtracting it adds height.
  const naturalLineHeightPx = ascenderPx - font.descender * scale;
  const lineHeightPx = naturalLineHeightPx * LINE_HEIGHT_FACTOR;

  return {
    lineHeightPx,
    ascenderPx,
    leadingPx: lineHeightPx - naturalLineHeightPx,
  };
}

/**
 * Greedy word wrap against a real pixel width.
 *
 * Splits on whitespace only — words are never broken mid-character. A single
 * word wider than `maxWidthPx` goes on its own line and overflows; the caller's
 * shrink loop is what actually resolves that.
 *
 * Any run of whitespace (including the admin's own line breaks) collapses to a
 * single space between words, as it always has. Each word keeps its slice of the
 * name mask, and the joining space is marked "not name", so a word like
 * "Ayush's" stays one word while only "Ayush" is marked. Line breaks and widths
 * depend on `text` alone — identical to the pre-mask behaviour.
 */
function wrapText(
  loaded: LoadedFont,
  styled: StyledText,
  maxWidthPx: number,
  fontSizePx: number,
): StyledText[] {
  // \S+ yields exactly the words the old split(/\s+/).filter(Boolean) did, but
  // with their offsets, which the mask slice needs.
  const words: StyledText[] = [];
  for (const match of styled.text.matchAll(/\S+/g)) {
    const start = match.index;
    words.push({
      text: match[0],
      nameMask: styled.nameMask.slice(start, start + match[0].length),
    });
  }

  if (words.length === 0) return [];

  const lines: StyledText[] = [];
  let current: StyledText | null = null;

  for (const word of words) {
    const candidate: StyledText = current
      ? {
          text: `${current.text} ${word.text}`,
          nameMask: [...current.nameMask, false, ...word.nameMask],
        }
      : word;

    if (measureWidth(loaded, candidate.text, fontSizePx) <= maxWidthPx) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  return lines;
}

type FittedText = {
  fontSizePx: number;
  lines: StyledText[];
  /**
   * True when the shrink loop found a size that genuinely fits the box on both
   * axes. False when it exhausted the range and fell back to the floor size,
   * meaning the text is expected to overflow.
   *
   * Purely diagnostic — the caller renders either way. It exists so the layout
   * log below can distinguish "this fitted at 113px" from "nothing fitted, so
   * here is the floor", which are very different situations that otherwise look
   * identical in the output.
   */
  fitted: boolean;
};

/**
 * Find the largest font size at which the wrapped text fits the bubble on BOTH
 * axes, never going below the MIN_FONT_SIZE floor.
 *
 * The width check is new: the old estimator assumed wrapping alone guaranteed a
 * fit, which is untrue for a single long word (a long child's name, most
 * obviously). Measuring real advance widths means an unbreakable word now drives
 * the shrink instead of silently spilling out of the bubble.
 *
 * If it hits the floor and still doesn't fit, it returns text at the floor size
 * and logs a warning — overflowing is better than dropping a page.
 */
function fitTextToBox(
  loaded: LoadedFont,
  styled: StyledText,
  boxWidthPx: number,
  boxHeightPx: number,
  initialFontSizePx: number,
  artworkHeight: number,
): FittedText {
  const minFontSizePx = Math.max(1, MIN_FONT_SIZE * artworkHeight);

  const fits = (fontSizePx: number): StyledText[] | null => {
    const lines = wrapText(loaded, styled, boxWidthPx, fontSizePx);
    if (lines.length === 0) return null;

    const widestLinePx = Math.max(
      ...lines.map((line) => measureWidth(loaded, line.text, fontSizePx)),
    );
    const totalHeightPx =
      lines.length * lineMetrics(loaded.font, fontSizePx).lineHeightPx;

    return widestLinePx <= boxWidthPx && totalHeightPx <= boxHeightPx ? lines : null;
  };

  for (
    let fontSizePx = Math.floor(initialFontSizePx);
    fontSizePx >= minFontSizePx;
    fontSizePx -= 1
  ) {
    const lines = fits(fontSizePx);
    if (lines) return { fontSizePx, lines, fitted: true };
  }

  logger.warn(
    {
      text: styled.text.substring(0, 40),
      boxWidthPx,
      boxHeightPx,
      minFontSizePx,
    },
    "Text does not fit in bubble even at minimum font size — will overflow",
  );

  return {
    fontSizePx: minFontSizePx,
    lines: wrapText(loaded, styled, boxWidthPx, minFontSizePx),
    fitted: false,
  };
}

// ============================================================
// SVG GENERATION (glyph outlines — no <text>, no fonts required)
// ============================================================

type BubbleSvgInputs = {
  /** For the error message and log if the path data fails the safety check. */
  bubbleId: string;
  widthPx: number;
  heightPx: number;
  lines: StyledText[];
  fontSizePx: number;
  loaded: LoadedFont;
  /** Bubble.fontColor — a validated 6-digit hex string, e.g. "#1a1a1a". */
  fill: string;
  /**
   * Colour for the {name} runs, or null when the name is drawn in `fill` like
   * everything else. Resolved by the caller: null whenever Bubble.nameColor is
   * unset OR equal to fontColor, so the single-colour path is taken in both.
   */
  nameFill: string | null;
  /** Bubble.textAlign — horizontal placement of each line within the box. */
  align: TextAlign;
  /** Bubble.textVerticalAlign — placement of the whole line block in the box. */
  verticalAlign: TextVerticalAlign;
};

/**
 * Render the wrapped lines as glyph outlines, placed inside the bubble box
 * according to the bubble's horizontal and vertical alignment.
 *
 * One <path> per colour: a single path when the name shares the text colour
 * (byte-identical to the output before nameColor existed), two when it doesn't.
 *
 * There is no <text>, no font-family and no @font-face here by design — the
 * output depends on nothing installed on the host. Note also that no
 * user-supplied string reaches the SVG any more: path data is pure numbers and
 * `fill` / `nameFill` are hex colours the Zod schema has already matched against
 * /^#[0-9a-f]{6}$/ (nameFill re-checked in resolveNameFill) — none can carry a
 * quote or an angle bracket, so the
 * XML-escaping hazard that used to require escapeXml() is gone entirely.
 */
function buildBubbleSvg(inputs: BubbleSvgInputs): string {
  const {
    bubbleId,
    widthPx,
    heightPx,
    lines,
    fontSizePx,
    loaded,
    fill,
    nameFill,
    align,
    verticalAlign,
  } = inputs;
  const { lineHeightPx, ascenderPx, leadingPx } = lineMetrics(
    loaded.font,
    fontSizePx,
  );

  // Place the block of lines vertically, then drop to the first baseline.
  // MIDDLE reproduces the old unconditional behaviour exactly.
  const blockHeightPx = lines.length * lineHeightPx;
  const blockTopPx =
    verticalAlign === "TOP"
      ? 0
      : verticalAlign === "BOTTOM"
        ? heightPx - blockHeightPx
        : (heightPx - blockHeightPx) / 2;
  const firstBaselineY = blockTopPx + leadingPx / 2 + ascenderPx;

  // Each line is placed on its own measured width — <path> has no text-anchor,
  // so horizontal alignment is arithmetic we do per line rather than an
  // attribute. Doing it per line (not once for the widest) is what gives a
  // left-aligned paragraph a straight left edge.
  //
  // Glyph outlines are collected into one bucket per colour. Each bucket
  // becomes one <path>, so a two-colour bubble is exactly two paths.
  const textPaths: string[] = [];
  const namePaths: string[] = [];

  lines.forEach((line, index) => {
    // Placement uses the WHOLE line's width, colour or no colour, so a
    // two-colour line sits exactly where the single-colour line would.
    const lineWidthPx = measureWidth(loaded, line.text, fontSizePx);
    const x =
      align === "LEFT"
        ? 0
        : align === "RIGHT"
          ? widthPx - lineWidthPx
          : (widthPx - lineWidthPx) / 2;
    const baselineY = firstBaselineY + index * lineHeightPx;

    // Single colour: draw the line in one call, exactly as before nameColor
    // existed. This is what keeps every existing bubble pixel-identical.
    if (!nameFill) {
      textPaths.push(buildLinePathData(loaded, line.text, x, baselineY, fontSizePx));
      return;
    }

    // Two colours: draw each run on its own, starting where the text before it
    // on this line ends. Measuring the prefix keeps the kerning and spacing
    // INSIDE the prefix; only the one kerning pair straddling a colour change
    // is lost (a pixel or two), which was accepted over a far more complex
    // glyph-level split.
    for (const run of splitIntoColourRuns(line)) {
      // Whitespace-only runs draw nothing — skip rather than emit empty data.
      if (run.text.trim().length === 0) continue;

      const offsetPx =
        run.start === 0
          ? 0
          : measureWidth(loaded, line.text.slice(0, run.start), fontSizePx);

      (run.isName ? namePaths : textPaths).push(
        buildLinePathData(loaded, run.text, x + offsetPx, baselineY, fontSizePx),
      );
    }
  });

  const textData = textPaths.join(" ");
  const nameData = namePaths.join(" ");

  assertSafePathData(textData, bubbleId);
  assertSafePathData(nameData, bubbleId);

  // Single-colour output is byte-for-byte the old SVG. In two-colour mode an
  // empty bucket (a bubble that is only "{name}", say) is left out entirely.
  const paths: string[] = [];
  if (!nameFill || textData.length > 0) {
    paths.push(`<path d="${textData}" fill="${fill}"/>`);
  }
  if (nameFill && nameData.length > 0) {
    paths.push(`<path d="${nameData}" fill="${nameFill}"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">${paths.join("")}</svg>`;
}

/**
 * Decide whether a bubble draws its name in a second colour.
 *
 * Returns null — meaning "one colour, the old code path" — when nameColor is
 * unset or is the same colour as the text anyway. Otherwise returns the colour.
 *
 * The pattern check is defence in depth, not validation: Zod already enforced
 * it on every write. It is here because this string is interpolated straight
 * into SVG markup, and the module's guarantee is that no unchecked string ever
 * reaches the SVG (see the note on buildBubbleSvg).
 */
function resolveNameFill(bubble: BubbleWithFont): string | null {
  const nameColor = bubble.nameColor?.toLowerCase() ?? null;

  if (!nameColor || nameColor === bubble.fontColor.toLowerCase()) return null;

  if (!FONT_COLOR_PATTERN.test(nameColor)) {
    throw new ValidationError(
      `Bubble ${bubble.id} has an invalid nameColor "${bubble.nameColor}". ` +
        `It must be a 6-digit hex colour like "#1a1a1a".`,
    );
  }

  return nameColor;
}

// ============================================================
// ENTRY POINT
// ============================================================

/**
 * Stamp personalized dialogue onto a page's artwork.
 *
 * Downloads the artwork and every font referenced by the page's bubbles,
 * substitutes tokens ({name}, {pronoun_*}) with real values, fits and wraps text
 * to each bubble using real glyph metrics, converts it to outlines, then
 * composites every bubble onto the artwork in one Sharp operation.
 *
 * Returns the resulting PNG buffer. Does NOT upload — the worker does that.
 *
 * Throws (rather than rendering a blank bubble) when a bubble has dialogue but
 * no font assigned, when a font file cannot be parsed, or when the font lacks
 * glyphs for the text. All three used to produce a silently blank page.
 */
export async function stampTextOnPage(params: StampTextParams): Promise<Buffer> {
  const { page, bubbles, childName, pronounKey } = params;

  // --- Guard the invariants the worker should have already checked, but defense in depth ---
  if (!page.artworkUrl || !page.artworkWidth || !page.artworkHeight) {
    throw new ValidationError(
      `Page ${page.id} is missing artwork or artwork dimensions — cannot stamp text.`,
    );
  }

  // --- Download artwork ---
  const artworkKey = getKeyFromPublicUrl(page.artworkUrl);
  const artworkBuffer = await downloadFileToBuffer("public", artworkKey);

  logger.debug(
    { pageId: page.id, bubbleCount: bubbles.length },
    "Starting text stamp",
  );

  // --- No bubbles? Nothing to stamp. Return artwork as-is. ---
  if (bubbles.length === 0) return artworkBuffer;

  // --- Download and parse every font referenced, cached by key ---
  //
  // Parsed once per page and reused across bubbles sharing a font. This cache is
  // deliberately function-scoped (not module-level) — see the note in
  // PROJECT_CONTEXT: fonts are re-fetched per job by design.
  const fontCache = new Map<string, LoadedFont>();

  for (const bubble of bubbles) {
    if (!bubble.font) continue;
    if (fontCache.has(bubble.font.fileUrl)) continue;

    const fontBuffer = await downloadFileToBuffer("private", bubble.font.fileUrl);
    const font = parseFont(fontBuffer, bubble.font.name, bubble.font.fileUrl);

    // Probe for shaper compatibility here, once, while we hold the font — not
    // lazily at the first measurement. fitTextToBox measures the same font
    // hundreds of times per bubble, and this answer never changes.
    fontCache.set(bubble.font.fileUrl, {
      font,
      name: bubble.font.name,
      canShape: detectShapingSupport(font, bubble.font.name, bubble.font.fileUrl),
    });
  }

  // --- Build a composite entry per bubble ---
  const composites: OverlayOptions[] = [];

  for (const bubble of bubbles) {
    // 1. Substitute tokens, then apply the bubble's casing.
    //
    // Order matters and this is the only correct place for it. Everything
    // downstream — the glyph-coverage guard, the width measurements that drive
    // wrapping, and the shrink loop that fits the text to its box — has to see
    // the exact characters that will be drawn. Casing anywhere later would
    // verify and measure one string while painting another.
    //
    // The transform covers the substituted child name too: "keep this bubble in
    // caps" means the whole line, not everything except the name.
    //
    // Substitution keeps track of which characters are the name (the mask), so
    // a bubble with a nameColor can paint them differently at the end. See
    // buildStyledText for why casing is applied per segment.
    const styled = buildStyledText(
      substituteTokensToSegments(bubble.dialogue, childName, pronounKey),
      bubble.textCase,
    );
    const finalText = styled.text;

    // Nothing to draw. A whitespace-only bubble is not an error — skip it.
    if (finalText.length === 0) continue;

    // 2. Resolve the font.
    //
    // Fail loud. There is no fallback font available: relying on a system font
    // is exactly the bug this module was rewritten to remove, and in the
    // production container there is no system font to fall back to at all.
    // Silently skipping would ship a printed book with missing dialogue.
    if (!bubble.font) {
      throw new ValidationError(
        `Bubble ${bubble.id} on page ${page.id} has dialogue but no font assigned. ` +
          `Assign a font to this bubble in the admin panel — there is no fallback font.`,
      );
    }

    const loaded = fontCache.get(bubble.font.fileUrl)!;

    // Coverage is checked against the character map, which is exactly what the
    // unshaped path renders from — so this guard stays accurate on both routes.
    assertGlyphCoverage(loaded.font, finalText, bubble.font.name);

    // 3. Convert normalized coords to pixels
    const xPx = Math.round(bubble.x * page.artworkWidth);
    const yPx = Math.round(bubble.y * page.artworkHeight);
    const widthPx = Math.round(bubble.width * page.artworkWidth);
    const heightPx = Math.round(bubble.height * page.artworkHeight);
    const initialFontSizePx = bubble.fontSize * page.artworkHeight;

    // 4. Fit text into the bubble using real metrics
    const { fontSizePx, lines, fitted } = fitTextToBox(
      loaded,
      styled,
      widthPx,
      heightPx,
      initialFontSizePx,
      page.artworkHeight,
    );

    if (lines.length === 0) continue;

    // --- Layout diagnostics ---
    //
    // Every number the renderer actually decided with, in one line. This exists
    // because a bubble that renders wrong gives you only an image to work from,
    // and reverse-engineering these values by measuring pixels is slow and
    // ambiguous — two different causes (a box too narrow vs. a measurement that
    // under-reports) produce the same looking output.
    //
    // The three that matter most when text comes out truncated:
    //   fitted            false means nothing fitted and this is the floor size
    //   overflowPx        > 0 means the text is wider than its own SVG canvas,
    //                     and buildBubbleSvg will clip whatever spills past it
    //   artworkWidth/Height  the DB's idea of the artwork size; every box and
    //                     font-size number below is derived from these, so if
    //                     they disagree with the real file everything downstream
    //                     is wrong in a way no other log would reveal.
    const measuredWidthPx = Math.max(
      ...lines.map((line) => measureWidth(loaded, line.text, fontSizePx)),
    );
    const blockHeightPx = lines.length * lineMetrics(loaded.font, fontSizePx).lineHeightPx;

    // Resolved before logging so the log shows what was actually used: null
    // means the name was drawn in the text colour (unset, or same colour).
    const nameFill = resolveNameFill(bubble);

    // Deliberately `info`, not `debug`: the logger runs at level "info" whenever
    // NODE_ENV is production (see lib/logger.ts), so a debug line here would be
    // invisible in exactly the environment where a bad render is most expensive
    // to reproduce. One line per bubble is a fair price for that. Drop it to
    // debug once bubble geometry is no longer under investigation.
    logger.info(
      {
        pageId: page.id,
        bubbleId: bubble.id,
        fontName: bubble.font.name,
        canShape: loaded.canShape,

        // What we are drawing
        text: finalText.slice(0, 60),
        textLength: finalText.length,
        lines: lines.map((line) => line.text),

        // The DB's artwork dimensions — everything below is derived from these
        artworkWidth: page.artworkWidth,
        artworkHeight: page.artworkHeight,

        // Stored bubble geometry (normalized 0–1)
        bubble: {
          x: bubble.x,
          y: bubble.y,
          width: bubble.width,
          height: bubble.height,
          fontSize: bubble.fontSize,
        },

        // Placement and casing. Logged because they change both what is drawn
        // and how wide it measures — UPPERCASE in particular runs wider and can
        // push measuredWidthPx past boxWidthPx, which is the clip condition.
        textAlign: bubble.textAlign,
        textVerticalAlign: bubble.textVerticalAlign,
        textCase: bubble.textCase,

        // Colours. nameFill is null when the name uses the text colour.
        fontColor: bubble.fontColor,
        nameColor: bubble.nameColor,
        nameFill,

        // Resolved pixel geometry — boxWidthPx IS the SVG canvas width
        xPx,
        yPx,
        boxWidthPx: widthPx,
        boxHeightPx: heightPx,

        // Sizing decision
        initialFontSizePx,
        chosenFontSizePx: fontSizePx,
        fitted,

        // The comparison that decides whether anything gets clipped
        measuredWidthPx: Math.round(measuredWidthPx),
        overflowPx: Math.round(measuredWidthPx - widthPx),
        blockHeightPx: Math.round(blockHeightPx),
        verticalOverflowPx: Math.round(blockHeightPx - heightPx),
      },
      "Bubble layout resolved",
    );

    // 5. Build the SVG (glyph outlines)
    const svg = buildBubbleSvg({
      bubbleId: bubble.id,
      widthPx,
      heightPx,
      lines,
      fontSizePx,
      loaded,
      fill: bubble.fontColor,
      nameFill,
      align: bubble.textAlign,
      verticalAlign: bubble.textVerticalAlign,
    });

    composites.push({
      input: Buffer.from(svg),
      top: yPx,
      left: xPx,
    });
  }

  // Every bubble was empty — skip the re-encode and hand back the original.
  if (composites.length === 0) return artworkBuffer;

  // --- Composite everything onto the artwork in one call ---
  //
  // compressionLevel 9 + adaptive filtering = smaller output, lossless.
  // Sharp's default is level 6 which produces significantly larger files
  // than the source PNG. Level 9 is slower to encode but produces the
  // smallest lossless PNG. This is the version stored in R2 and shown to
  // the user — quality is not compromised, only file size.
  const stampedBuffer = await sharp(artworkBuffer)
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  logger.info(
    {
      pageId: page.id,
      bubbleCount: bubbles.length,
      fontsLoaded: fontCache.size,
      // Names of any fonts rendered without shaping. Empty on a normal page.
      // Non-empty means those fonts lost ligatures — the page is correct but
      // plainer, and this is the breadcrumb that says which font to replace.
      unshapedFonts: [...fontCache.values()]
        .filter((entry) => !entry.canShape)
        .map((entry) => entry.name),
      bubblesStamped: composites.length,
    },
    "Text stamped onto page",
  );

  return stampedBuffer;
}
