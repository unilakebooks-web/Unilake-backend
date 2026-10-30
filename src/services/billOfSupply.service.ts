// src/services/billOfSupply.service.ts
//
// Bill of Supply for paid INR orders.
//
// Two halves:
//   1. assignBillNumber — runs inside the payment-captured transaction and
//      gives the order its permanent serial ("BOS-26-00001") and issue date.
//   2. buildBillOfSupplyPdf — builds the PDF in memory when an admin downloads
//      it. Nothing is stored: not the PDF, not in R2. Re-downloading rebuilds
//      the same bill from the order's saved number, date and snapshot fields.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @pdf-lib/fontkit's Indic (Devanagari) shaper is compiled with Babel
// generators but does not bundle their runtime, so laying out Hindi text
// throws "regeneratorRuntime is not defined" without this global install.
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import type { Prisma } from "../generated/prisma/client.js";

const ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets"
);

// ── Seller details (fixed, printed on every bill) ──────────────────────────

const SELLER_LINES = [
  "971, Babulal Karkhana",
  "Jhansi - 284001",
  "Uttar Pradesh",
  "GSTIN: 09AYYPG0946P1ZG",
  "Phone: 9277163463",
];
const SELLER_NAME = "Unilake Creations";
const HSN_CODE = "4903";
const BILL_PREFIX = "BOS";
const IST = "Asia/Kolkata";

// ============================================================
// 1. NUMBERING
// ============================================================

/**
 * The Indian financial year (April–March) a moment falls in, keyed by the
 * calendar year it starts in: 15 Mar 2027 → 2026 (FY 2026-27). Judged in IST,
 * so a payment at 00:30 on 1 April IST counts in the new year even though it
 * is still 31 March in UTC.
 */
function financialYearOf(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return month >= 4 ? year : year - 1;
}

/** "BOS-26-00001" — FY 2026-27, serial 1. Printed with a leading "#". */
function formatBillNumber(financialYear: number, serial: number): string {
  const yy = String(financialYear % 100).padStart(2, "0");
  return `${BILL_PREFIX}-${yy}-${String(serial).padStart(5, "0")}`;
}

/**
 * Gives an order its Bill of Supply number and issue date. Call ONLY inside
 * the transaction that flips the order to PAID, and only when that flip
 * actually happened — so each paid order gets exactly one number, a webhook
 * redelivery never takes a second, and a rolled-back payment takes none.
 *
 * The counter is advanced with one INSERT … ON CONFLICT … RETURNING, which
 * Postgres runs atomically: two payments committing at the same instant get
 * consecutive numbers, never the same one. The first payment of a new
 * financial year creates that year's row at serial 1.
 */
export async function assignBillNumber(
  tx: Prisma.TransactionClient,
  orderId: string,
  paidAt: Date
): Promise<string> {
  const financialYear = financialYearOf(paidAt);

  const [counter] = await tx.$queryRaw<{ lastSerial: number }[]>`
    INSERT INTO "bill_counters" ("financialYear", "lastSerial", "updatedAt")
    VALUES (${financialYear}, 1, NOW())
    ON CONFLICT ("financialYear")
    DO UPDATE SET "lastSerial" = "bill_counters"."lastSerial" + 1, "updatedAt" = NOW()
    RETURNING "lastSerial"
  `;

  if (!counter) {
    // RETURNING always yields the row; this only guards the type.
    throw new Error(`Bill counter returned no row for FY ${financialYear}`);
  }

  const billNumber = formatBillNumber(financialYear, Number(counter.lastSerial));

  await tx.order.update({
    where: { id: orderId },
    data: { billNumber, billIssuedAt: paidAt },
  });

  return billNumber;
}

// ============================================================
// 2. PDF
// ============================================================

/** Everything the bill needs, loaded and checked. */
async function loadBillData(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      billNumber: true,
      billIssuedAt: true,
      amount: true,
      currency: true,
      shippingName: true,
      shippingLine1: true,
      shippingLine2: true,
      shippingCity: true,
      shippingState: true,
      shippingZip: true,
      shippingPhone: true,
      orderSession: { select: { childName: true } },
    },
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  if (!order.billNumber || !order.billIssuedAt) {
    throw new ConflictError(
      "This order has no Bill of Supply. Bills are issued only for INR orders paid after billing was switched on."
    );
  }

  return { ...order, billNumber: order.billNumber, billIssuedAt: order.billIssuedAt };
}

// ── Fonts ───────────────────────────────────────────────────────────────────
//
// Noto Sans for Latin text and the ₹ sign, Noto Sans Devanagari for Hindi. A
// string is split into runs and each run drawn in whichever font has its
// glyphs, so a Hindi name or address prints instead of crashing the PDF (the
// built-in PDF fonts cannot encode anything outside Latin-1). Characters
// neither font has are printed as "?".
//
// Known limit: pdf-lib does not fully shape Devanagari, so some conjuncts may
// render as their separate letters. Still readable.

type FontPair = { font: PDFFont; chars: Set<number> };
/** `deva` is null on bills with no Hindi text — see embedFonts. */
type Fonts = { latin: FontPair; deva: FontPair | null };

async function loadFontBytes(file: string) {
  return readFile(path.join(ASSETS_DIR, "fonts", file));
}

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;

/** A stand-in for the Devanagari fonts on bills with no Hindi in them. */
const NO_FONT: FontPair | null = null;

/**
 * Fonts are embedded WHOLE (`subset: false`): pdf-lib's subsetting drops
 * glyphs from the Noto fonts and scrambles text extraction once two fonts are
 * mixed. Whole fonts make the file larger, so the Devanagari pair is embedded
 * only when the bill actually contains Hindi text.
 */
async function embedFonts(pdf: PDFDocument, needsDevanagari: boolean) {
  const embed = async (file: string): Promise<FontPair> => {
    const font = await pdf.embedFont(await loadFontBytes(file), { subset: false });
    return { font, chars: new Set(font.getCharacterSet()) };
  };

  const [regular, bold, devaRegular, devaBold] = await Promise.all([
    embed("NotoSans-Regular.ttf"),
    embed("NotoSans-Bold.ttf"),
    needsDevanagari ? embed("NotoSansDevanagari-Regular.ttf") : NO_FONT,
    needsDevanagari ? embed("NotoSansDevanagari-Bold.ttf") : NO_FONT,
  ]);

  return {
    regular: { latin: regular, deva: devaRegular } as Fonts,
    bold: { latin: bold, deva: devaBold } as Fonts,
  };
}

type Run = { text: string; font: PDFFont };

/** Zero-width joiner / non-joiner, which steer how Devanagari letters combine. */
const JOINERS = /[‌‍]/;

/**
 * Splits text into runs, each drawn in one font. Devanagari goes to the
 * Devanagari font first — Noto Sans also carries Devanagari glyphs, but only
 * the dedicated font has the shaping rules that join the letters properly.
 * Spaces and joiners inside Hindi stay in the Hindi run so a phrase is shaped
 * as one piece. Everything else uses Noto Sans; anything neither font has
 * prints as "?".
 */
function toRuns(text: string, fonts: Fonts): Run[] {
  const runs: Run[] = [];

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const last = runs[runs.length - 1];
    const inHindiRun = fonts.deva !== null && last?.font === fonts.deva.font;

    const wantsDeva =
      fonts.deva !== null &&
      fonts.deva.chars.has(code) &&
      (DEVANAGARI.test(ch) || (inHindiRun && (/\s/.test(ch) || JOINERS.test(ch))));

    const pair = wantsDeva
      ? fonts.deva
      : fonts.latin.chars.has(code)
        ? fonts.latin
        : fonts.deva?.chars.has(code)
          ? fonts.deva
          : null;

    const font = pair?.font ?? fonts.latin.font;
    const glyph = pair ? ch : "?";

    if (last && last.font === font) last.text += glyph;
    else runs.push({ text: glyph, font });
  }

  return runs;
}

/**
 * pdf-lib measures Devanagari with the shaper's mark positioning but draws it
 * without, so a Hindi run comes out wider on the page than it measures.
 * Padding the measurement keeps wrapped Hindi inside its column.
 */
const DEVANAGARI_WIDTH_FACTOR = 1.25;

function runWidth(run: Run, size: number, fonts: Fonts): number {
  const width = run.font.widthOfTextAtSize(run.text, size);
  return run.font === fonts.deva?.font ? width * DEVANAGARI_WIDTH_FACTOR : width;
}

function textWidth(text: string, size: number, fonts: Fonts): number {
  return toRuns(text, fonts).reduce((sum, run) => sum + runWidth(run, size, fonts), 0);
}

type DrawOpts = {
  x: number;
  y: number;
  size: number;
  fonts: Fonts;
  color?: ReturnType<typeof rgb>;
};

function drawText(page: PDFPage, text: string, opts: DrawOpts) {
  let x = opts.x;
  for (const run of toRuns(text, opts.fonts)) {
    page.drawText(run.text, {
      x,
      y: opts.y,
      size: opts.size,
      font: run.font,
      color: opts.color ?? BLACK,
    });
    x += runWidth(run, opts.size, opts.fonts);
  }
}

/** Word-wraps to `maxWidth`; a single word longer than the line is split. */
function wrapText(text: string, maxWidth: number, size: number, fonts: Fonts): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, fonts) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);

    // Over-long word: break it character by character.
    line = "";
    for (const ch of word) {
      if (textWidth(line + ch, size, fonts) > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
  }

  if (line) lines.push(line);
  return lines;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** "₹1,500.00" — Indian digit grouping. */
function formatRupees(amount: Prisma.Decimal): string {
  return `₹${Number(amount).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "29/10/2026", in IST. */
function formatIssueDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: IST });
}

// ── Layout ──────────────────────────────────────────────────────────────────
//
// A4 portrait, measured from the client's sample: 1px of the 900px-wide
// sample ≈ 0.661pt. pdf-lib's y axis runs UP from the bottom edge, so `top()`
// converts a distance from the top of the page.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const top = (fromTop: number) => PAGE_HEIGHT - fromTop;

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const HEADER_FILL = rgb(0.137, 0.137, 0.137); // #232323
const BRAND_PURPLE = rgb(0.569, 0.29, 0.549); // #914A8C

const BODY_SIZE = 10.5;
const LINE_GAP = 15;

/** Table column edges (pt), left to right: S.No | Description | HSN | Rate | QTY | Amount. */
const COLS: readonly number[] = [24.5, 80.6, 291.5, 355, 429.6, 484.5, 575];
const TABLE_LEFT = 24.5;
const TABLE_RIGHT = 575;
const AMOUNT_COL = 5;
/** Left edge of column `i` (i = 0..6, where 6 is the table's right edge). */
const colX = (i: number): number => COLS[i]!;
const TABLE_TOP = 214;
const HEADER_BOTTOM = 266;
const ROW_BOTTOM = 323;
const TOTAL_BOTTOM = 363;

/**
 * Builds the Bill of Supply PDF for one order, entirely in memory.
 * Returns the bytes and a download file name; the caller streams them out.
 */
export async function buildBillOfSupplyPdf(
  orderId: string
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const data = await loadBillData(orderId);
  const bytes = await renderBillOfSupplyPdf(data);
  return { bytes, fileName: `${data.billNumber}.pdf` };
}

export type BillData = Awaited<ReturnType<typeof loadBillData>>;

/** Draws the bill from already-loaded data. Pure — no DB access. */
export async function renderBillOfSupplyPdf(data: BillData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Bill of Supply ${data.billNumber}`);
  pdf.setAuthor(SELLER_NAME);

  const customerText = [
    data.shippingName,
    data.shippingLine1,
    data.shippingLine2,
    data.shippingCity,
    data.shippingState,
    data.shippingZip,
    data.shippingPhone,
    data.orderSession.childName,
  ].join(" ");
  const { regular, bold } = await embedFonts(pdf, DEVANAGARI.test(customerText));
  const logo = await pdf.embedPng(await readFile(path.join(ASSETS_DIR, "unilake-logo.png")));

  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // ── Logo: the wordmark on a rounded purple tile ────────────────────────────
  const tile = { x: 32, top: 24, width: 123, height: 47, radius: 8 };
  page.drawSvgPath(roundedRectPath(tile.width, tile.height, tile.radius), {
    x: tile.x,
    y: top(tile.top),
    color: BRAND_PURPLE,
  });
  const logoHeight = tile.height - 10;
  const logoWidth = (logo.width / logo.height) * logoHeight;
  page.drawImage(logo, {
    x: tile.x + (tile.width - logoWidth) / 2,
    y: top(tile.top + tile.height - 5),
    width: logoWidth,
    height: logoHeight,
  });

  // ── Title ──────────────────────────────────────────────────────────────────
  const title = "Bill of Supply";
  const titleSize = 26;
  drawText(page, title, {
    x: 305 - textWidth(title, titleSize, bold) / 2,
    y: top(57),
    size: titleSize,
    fonts: bold,
  });

  // ── Billed By ──────────────────────────────────────────────────────────────
  const blockTop = 99;
  drawText(page, "Billed By", { x: 32, y: top(blockTop), size: BODY_SIZE, fonts: regular });
  drawText(page, SELLER_NAME, {
    x: 32,
    y: top(blockTop + LINE_GAP),
    size: BODY_SIZE,
    fonts: bold,
  });
  SELLER_LINES.forEach((line, i) =>
    drawText(page, line, {
      x: 32,
      y: top(blockTop + LINE_GAP * (i + 2)),
      size: BODY_SIZE,
      fonts: regular,
    })
  );

  // ── Billed To ──────────────────────────────────────────────────────────────
  // Name, then the address wrapped to the column, then the phone — the phone
  // sits on the seller's phone line unless the address runs past it.
  const toX = 198;
  const toWidth = 160;
  const addressText = [
    data.shippingLine1,
    data.shippingLine2,
    [data.shippingCity, data.shippingZip].filter(Boolean).join(" - "),
    data.shippingState,
  ]
    .filter((part) => part && part.trim())
    .join(", ");

  const toLines = [
    ...wrapText(data.shippingName ?? "", toWidth, BODY_SIZE, regular),
    ...wrapText(addressText, toWidth, BODY_SIZE, regular),
  ];

  drawText(page, "Billed To", { x: toX, y: top(blockTop), size: BODY_SIZE, fonts: regular });
  toLines.forEach((line, i) =>
    drawText(page, line, {
      x: toX,
      y: top(blockTop + LINE_GAP * (i + 1)),
      size: BODY_SIZE,
      fonts: regular,
    })
  );

  if (data.shippingPhone) {
    const phoneLine = Math.max(SELLER_LINES.length + 1, toLines.length + 1);
    drawText(page, data.shippingPhone, {
      x: toX,
      y: top(blockTop + LINE_GAP * phoneLine),
      size: BODY_SIZE,
      fonts: regular,
    });
  }

  // ── Bill details (right column) ────────────────────────────────────────────
  const labelX = 368;
  const valueX = 463;
  const valueWidth = PAGE_WIDTH - 24 - valueX;

  drawText(page, "Unique Serial", { x: labelX, y: top(blockTop), size: BODY_SIZE, fonts: regular });
  drawText(page, "No:", { x: labelX + 12, y: top(blockTop + LINE_GAP), size: BODY_SIZE, fonts: regular });
  drawText(page, `#${data.billNumber}`, { x: valueX, y: top(blockTop), size: BODY_SIZE, fonts: regular });

  drawText(page, "Date of Issue:", { x: labelX, y: top(blockTop + 37), size: BODY_SIZE, fonts: regular });
  drawText(page, formatIssueDate(data.billIssuedAt), {
    x: valueX,
    y: top(blockTop + 37),
    size: BODY_SIZE,
    fonts: regular,
  });

  drawText(page, "Place of Supply:", { x: labelX, y: top(blockTop + 68), size: BODY_SIZE, fonts: regular });
  wrapText(data.shippingState ?? "", valueWidth, BODY_SIZE, regular).forEach((line, i) =>
    drawText(page, line, {
      x: valueX,
      y: top(blockTop + 68 + LINE_GAP * i),
      size: BODY_SIZE,
      fonts: regular,
    })
  );

  // ── Table ──────────────────────────────────────────────────────────────────
  drawTable(page, data, { regular, bold });

  // ── Footer notes ───────────────────────────────────────────────────────────
  const noteSize = 9.5;
  wrapText(
    "Declaration: We declare that the goods sold are intended for end user consumption and not for resale.",
    270,
    noteSize,
    regular
  ).forEach((line, i) =>
    drawText(page, line, { x: 28, y: top(385 + 14 * i), size: noteSize, fonts: regular })
  );

  wrapText(
    "* This is a computer generated bill and does not require a physical signature",
    240,
    11,
    regular
  ).forEach((line, i) =>
    drawText(page, line, { x: 330, y: top(385 + 16 * i), size: 11, fonts: regular })
  );

  return pdf.save();
}

function drawTable(
  page: PDFPage,
  data: BillData,
  fonts: { regular: Fonts; bold: Fonts }
) {
  const left = TABLE_LEFT;
  const right = TABLE_RIGHT;
  const border = { thickness: 1.3, color: BLACK };

  // Header band.
  page.drawRectangle({
    x: left,
    y: top(HEADER_BOTTOM),
    width: right - left,
    height: HEADER_BOTTOM - TABLE_TOP,
    color: HEADER_FILL,
  });

  // Outer frame and horizontal rules.
  page.drawRectangle({
    x: left,
    y: top(TOTAL_BOTTOM),
    width: right - left,
    height: TOTAL_BOTTOM - TABLE_TOP,
    borderWidth: border.thickness,
    borderColor: BLACK,
  });
  for (const y of [HEADER_BOTTOM, ROW_BOTTOM]) {
    page.drawLine({ start: { x: left, y: top(y) }, end: { x: right, y: top(y) }, ...border });
  }

  // Column dividers run through header + item row; only the Amount divider
  // continues through the Grand Total row.
  COLS.slice(1, -1).forEach((x, i) => {
    const isAmountEdge = i + 1 === AMOUNT_COL;
    page.drawLine({
      start: { x, y: top(TABLE_TOP) },
      end: { x, y: top(isAmountEdge ? TOTAL_BOTTOM : ROW_BOTTOM) },
      ...border,
    });
  });

  const size = 11;
  const amount = formatRupees(data.amount);

  /**
   * Centres text in a cell, vertically and horizontally. Text with spaces
   * wraps; a single token (an amount, a code) is shrunk to fit instead, so
   * "₹1,50,000.00" never splits across lines in the narrow Rate column.
   */
  const cell = (
    col: number,
    rowTop: number,
    rowBottom: number,
    text: string,
    cellFonts: Fonts,
    color = BLACK
  ) => {
    const x0 = colX(col);
    const x1 = colX(col + 1);
    const maxWidth = x1 - x0 - 10;

    const isSingleToken = !/\s/.test(text.trim());
    const fitted = isSingleToken
      ? Math.min(size, (maxWidth / textWidth(text, size, cellFonts)) * size)
      : size;
    const lines = isSingleToken ? [text] : wrapText(text, maxWidth, fitted, cellFonts);

    const lineHeight = fitted * 1.35;
    const blockHeight = lines.length * lineHeight;
    const firstBaseline =
      rowTop + (rowBottom - rowTop - blockHeight) / 2 + fitted;

    lines.forEach((line, i) =>
      drawText(page, line, {
        x: x0 + (x1 - x0 - textWidth(line, fitted, cellFonts)) / 2,
        y: top(firstBaseline + lineHeight * i),
        size: fitted,
        fonts: cellFonts,
        color,
      })
    );
  };

  // Header — bold where the sample is bold (S.No, HSN, Amount).
  const headers: [string, Fonts][] = [
    ["S.No", fonts.bold],
    ["Description", fonts.regular],
    ["HSN", fonts.bold],
    ["Rate", fonts.regular],
    ["QTY.", fonts.regular],
    ["Amount", fonts.bold],
  ];
  headers.forEach(([text, f], col) => cell(col, TABLE_TOP, HEADER_BOTTOM, text, f, WHITE));

  // The single line item. Underscore format is the client's.
  const childName = data.orderSession.childName?.trim() || "Child";
  const row = ["1", `${childName}_Personalized Book`, HSN_CODE, amount, "1", amount];
  row.forEach((text, col) => cell(col, HEADER_BOTTOM, ROW_BOTTOM, text, fonts.regular));

  // Grand Total — label right-aligned against the Amount column.
  const label = "Grand Total";
  drawText(page, label, {
    x: colX(AMOUNT_COL) - 12 - textWidth(label, size, fonts.regular),
    y: top((ROW_BOTTOM + TOTAL_BOTTOM) / 2 + size / 3),
    size,
    fonts: fonts.regular,
  });
  cell(AMOUNT_COL, ROW_BOTTOM, TOTAL_BOTTOM, amount, fonts.regular);
}

/** SVG path for a w×h rounded rectangle, origin at its top-left corner. */
function roundedRectPath(w: number, h: number, r: number): string {
  return [
    `M ${r} 0`,
    `H ${w - r}`,
    `Q ${w} 0 ${w} ${r}`,
    `V ${h - r}`,
    `Q ${w} ${h} ${w - r} ${h}`,
    `H ${r}`,
    `Q 0 ${h} 0 ${h - r}`,
    `V ${r}`,
    `Q 0 0 ${r} 0`,
    "Z",
  ].join(" ");
}
