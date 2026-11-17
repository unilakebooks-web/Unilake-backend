// Layout tests for the Bill of Supply. The renderer is pure (no database), but
// importing it loads the app's configuration, so the test environment is
// loaded first like the other integration tests.
//
// They read the PDF's word positions with `pdftotext -bbox` (poppler-utils).
// If that tool is not installed the tests are skipped with a clear reason; they
// are not a silent pass.
import "../setup/env.js";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { renderBillOfSupplyPdf } from "../../src/services/billOfSupply.service.js";

const hasPdftotext = spawnSync("pdftotext", ["-v"]).status !== null;

type Word = { x1: number; y1: number; x2: number; y2: number; text: string };

function words(pdf: Uint8Array): Word[] {
  const dir = mkdtempSync(path.join(tmpdir(), "bill-"));
  try {
    const file = path.join(dir, "bill.pdf");
    writeFileSync(file, pdf);
    const out = spawnSync("pdftotext", ["-bbox", file, "-"], {
      encoding: "utf8",
    });
    if (out.status !== 0) throw new Error(`pdftotext failed: ${out.stderr}`);
    return [
      ...out.stdout.matchAll(
        /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g
      ),
    ].map((m) => ({
      x1: Number(m[1]),
      y1: Number(m[2]),
      x2: Number(m[3]),
      y2: Number(m[4]),
      text: m[5]!
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const D = (value: string) => new Prisma.Decimal(value);

function sampleBill(overrides: Record<string, unknown> = {}, hindi = false) {
  return {
    billNumber: "BOS-26-00001",
    billIssuedAt: new Date("2026-11-16T10:00:00.000Z"),
    amount: D("999.00"),
    currency: "INR",
    shippingName: hindi ? "आरव शर्मा" : "Aarav Sharma",
    shippingLine1: hindi ? "12 गांधी रोड" : "12 Gandhi Road",
    shippingLine2: "Near Central Park",
    shippingCity: "Mumbai",
    shippingState: "Maharashtra",
    shippingZip: "400001",
    shippingPhone: "9999999999",
    orderSession: { childName: "Aarav" },
    listAmount: null,
    discountAmount: D("0"),
    couponCode: null,
    ...overrides,
  };
}

const discounted = (code = "FESTIVE-25") =>
  sampleBill({
    amount: D("799.20"),
    listAmount: D("999.00"),
    discountAmount: D("199.80"),
    couponCode: code,
  });

const golden = (name: string) =>
  readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8")
    .trim()
    .split("\n");
const asLines = (list: Word[]) =>
  list.map(
    (w) =>
      `${w.x1.toFixed(2)} ${w.y1.toFixed(2)} ${w.x2.toFixed(2)} ${w.y2.toFixed(2)} ${w.text}`
  );

describe.skipIf(!hasPdftotext)(
  "Bill of Supply layout (needs pdftotext)",
  () => {
    describe("a bill with no coupon", () => {
      it("is laid out exactly as before coupons existed (golden word positions)", async () => {
        expect(
          asLines(words(await renderBillOfSupplyPdf(sampleBill() as never)))
        ).toEqual(golden("bill-no-coupon.words.txt"));
      });

      it("is unchanged for a Hindi address too", async () => {
        expect(
          asLines(
            words(await renderBillOfSupplyPdf(sampleBill({}, true) as never))
          )
        ).toEqual(golden("bill-no-coupon-hindi.words.txt"));
      });

      it("is unchanged for an order placed before coupons existed (no list amount, zero discount)", async () => {
        const legacy = sampleBill({ listAmount: null, couponCode: null });
        expect(
          asLines(words(await renderBillOfSupplyPdf(legacy as never)))
        ).toEqual(golden("bill-no-coupon.words.txt"));
      });
    });

    describe("a bill with a coupon", () => {
      it("shows the list price, a signed discount line and the amount paid", async () => {
        const w = words(await renderBillOfSupplyPdf(discounted() as never));
        const texts = w.map((x) => x.text);
        expect(texts).toContain("Coupon");
        expect(texts).toContain("(FESTIVE-25)");
        expect(texts).toContain("-₹199.80");
        expect(texts.filter((t) => t === "₹999.00")).toHaveLength(2); // Rate and Amount of the item row
        expect(texts.filter((t) => t === "₹799.20")).toHaveLength(1); // Grand Total only
        expect(texts).toContain("Grand");
      });

      it("puts the discount row between the item row and the Grand Total, and moves what is below it down by one row", async () => {
        const plain = words(await renderBillOfSupplyPdf(sampleBill() as never));
        const coupon = words(
          await renderBillOfSupplyPdf(discounted() as never)
        );
        const at = (list: Word[], text: string) =>
          list.find((w) => w.text === text)!;

        const item = at(coupon, "Aarav_Personalized");
        expect(item.y1).toBeCloseTo(at(plain, "Aarav_Personalized").y1, 2); // item row did not move

        const discountY = at(coupon, "-₹199.80").y1;
        const totalY = at(coupon, "Grand").y1;
        expect(discountY).toBeGreaterThan(item.y1);
        expect(totalY).toBeGreaterThan(discountY);

        const shift = totalY - at(plain, "Grand").y1; // one row (40 points)
        expect(shift).toBeCloseTo(40, 0);
        expect(
          at(coupon, "Declaration:").y1 - at(plain, "Declaration:").y1
        ).toBeCloseTo(shift, 1);
      });

      it("fits the longest allowed code inside the row, left of the Amount column", async () => {
        const long = "A".repeat(32);
        const w = words(await renderBillOfSupplyPdf(discounted(long) as never));
        const amount = w.find((x) => x.text === "-₹199.80")!;
        // the label words sit on the same line as the amount (within a few points)
        const label = w.filter(
          (x) =>
            x !== amount && Math.abs(x.y1 - amount.y1) < 4 && x.x1 < amount.x1
        );
        expect(label.map((x) => x.text).join(" ")).toContain(long);
        for (const word of label) {
          expect(word.x1).toBeGreaterThan(24.5);
          expect(word.x2).toBeLessThan(484.5);
        }
      });

      it("renders on one page", async () => {
        const pdf = await PDFDocument.load(
          await renderBillOfSupplyPdf(discounted() as never)
        );
        expect(pdf.getPageCount()).toBe(1);
      });

      it("works with a Hindi address", async () => {
        const w = words(
          await renderBillOfSupplyPdf({
            ...discounted(),
            shippingName: "आरव शर्मा",
            shippingLine1: "12 गांधी रोड",
          } as never)
        );
        expect(w.map((x) => x.text)).toContain("-₹199.80");
      });

      it("derives the list price when an older row has a discount but no list amount", async () => {
        const w = words(
          await renderBillOfSupplyPdf({
            ...discounted(),
            listAmount: null,
          } as never)
        );
        expect(w.filter((x) => x.text === "₹999.00")).toHaveLength(2);
      });
    });
  }
);
