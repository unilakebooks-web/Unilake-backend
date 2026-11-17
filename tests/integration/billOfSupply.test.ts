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
    orderSession: { childName: "Aarav", comic: { title: "Alphabet Train" } },
    listAmount: null,
    discountAmount: D("0"),
    ...overrides,
  };
}

const discounted = () =>
  sampleBill({
    amount: D("799.20"),
    listAmount: D("999.00"),
    discountAmount: D("199.80"),
  });

// The stored word positions of a bill with no coupon. They pin the layout, so a
// deliberate layout change means regenerating them:
//   UPDATE_BILL_GOLDEN=1 npx vitest run tests/integration/billOfSupply.test.ts
// and reading the diff of tests/fixtures before committing it.
const expectGolden = (name: string, actual: string[]) => {
  const file = path.join(__dirname, "..", "fixtures", name);
  if (process.env.UPDATE_BILL_GOLDEN === "1") {
    writeFileSync(file, `${actual.join("\n")}\n`);
    return;
  }
  expect(actual).toEqual(readFileSync(file, "utf8").trim().split("\n"));
};
const asLines = (list: Word[]) =>
  list.map(
    (w) =>
      `${w.x1.toFixed(2)} ${w.y1.toFixed(2)} ${w.x2.toFixed(2)} ${w.y2.toFixed(2)} ${w.text}`
  );

describe.skipIf(!hasPdftotext)(
  "Bill of Supply layout (needs pdftotext)",
  () => {
    describe("a bill with no coupon", () => {
      it("keeps its layout (stored word positions)", async () => {
        expectGolden(
          "bill-no-coupon.words.txt",
          asLines(words(await renderBillOfSupplyPdf(sampleBill() as never)))
        );
      });

      it("keeps its layout for a Hindi address too", async () => {
        expectGolden(
          "bill-no-coupon-hindi.words.txt",
          asLines(
            words(await renderBillOfSupplyPdf(sampleBill({}, true) as never))
          )
        );
      });

      it("is the same for an order placed before coupons existed (no list amount, zero discount)", async () => {
        const legacy = sampleBill({ listAmount: null });
        expect(
          asLines(words(await renderBillOfSupplyPdf(legacy as never)))
        ).toEqual(
          asLines(words(await renderBillOfSupplyPdf(sampleBill() as never)))
        );
      });
    });

    describe("a bill with no discount", () => {
      it("still has a Discount row, showing 0.00 with no minus sign", async () => {
        const w = words(await renderBillOfSupplyPdf(sampleBill() as never));
        const texts = w.map((x) => x.text);
        expect(texts).toContain("Discount");
        expect(texts.filter((t) => t === "₹0.00")).toHaveLength(1);
        expect(texts.some((t) => t.startsWith("-₹"))).toBe(false);
        const label = w.find((x) => x.text === "Discount")!;
        const amount = w.find((x) => x.text === "₹0.00")!;
        expect(Math.abs(label.y1 - amount.y1)).toBeLessThan(4);
        expect(label.x2).toBeLessThan(amount.x1);
      });
    });

    describe("a bill with a coupon", () => {
      it("shows the list price, a signed discount line and the amount paid", async () => {
        const w = words(await renderBillOfSupplyPdf(discounted() as never));
        const texts = w.map((x) => x.text);
        expect(texts).toContain("Discount");
        expect(texts).toContain("-₹199.80");
        expect(texts.filter((t) => t === "₹999.00")).toHaveLength(2); // Rate and Amount of the item row
        expect(texts.filter((t) => t === "₹799.20")).toHaveLength(1); // Grand Total only
        expect(texts).toContain("Grand");
      });

      it("has the same layout as a bill with no coupon: the Discount row is always there", async () => {
        const plain = words(await renderBillOfSupplyPdf(sampleBill() as never));
        const coupon = words(
          await renderBillOfSupplyPdf(discounted() as never)
        );
        const at = (list: Word[], text: string) =>
          list.find((w) => w.text === text)!;

        for (const text of [
          "Aarav_Book_Alphabet",
          "Discount",
          "Grand",
          "Declaration:",
        ]) {
          expect(at(coupon, text).y1).toBeCloseTo(at(plain, text).y1, 2);
        }
        const item = at(coupon, "Aarav_Book_Alphabet").y1;
        expect(at(coupon, "-₹199.80").y1).toBeGreaterThan(item);
        expect(at(coupon, "Grand").y1).toBeGreaterThan(at(coupon, "-₹199.80").y1);
      });

      it("never prints the coupon code", async () => {
        const w = words(
          await renderBillOfSupplyPdf({
            ...discounted(),
            couponCode: "WELCOME10",
          } as never)
        );
        expect(w.some((x) => x.text.includes("WELCOME10"))).toBe(false);
      });

      it("puts the Discount label left of the amount, on the same line", async () => {
        const w = words(await renderBillOfSupplyPdf(discounted() as never));
        const amount = w.find((x) => x.text === "-₹199.80")!;
        const label = w.find((x) => x.text === "Discount")!;
        expect(Math.abs(label.y1 - amount.y1)).toBeLessThan(4);
        expect(label.x2).toBeLessThan(amount.x1);
        expect(label.x1).toBeGreaterThan(24);
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

    // Positions read from the client's final layout ("Bill of Supply with discount
    // tab - final"), in points from the top-left corner. The sample is set in
    // Arial and the bill in Noto Sans, so the checks are on left edges and on
    // distances between lines of the same size, with a margin for that.
    describe("matches the client's final layout", () => {
      const near = (actual: number, expected: number, margin = 1.5) =>
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(margin);
      const render = async (bill = discounted()) =>
        words(await renderBillOfSupplyPdf(bill as never));
      const first = (list: Word[], text: string) =>
        list.find((w) => w.text === text)!;

      it("starts each column where the sample does", async () => {
        const w = await render();
        near(first(w, "Billed").x1, 30.64); // Billed By
        near(w.filter((x) => x.text === "Billed")[1]!.x1, 193.01); // Billed To
        near(first(w, "Unique").x1, 359.3);
        near(first(w, "#BOS-26-00001").x1, 451.8);
        near(first(w, "Declaration:").x1, 23.08);
        near(first(w, "*").x1, 321.57);
      });

      it("centres the title on the page", async () => {
        const w = await render();
        const title = [first(w, "Bill"), first(w, "of"), first(w, "Supply")];
        near((title[0]!.x1 + title[2]!.x2) / 2, 297.6);
      });

      it("spaces the details block as the sample does", async () => {
        const w = await render();
        const unique = first(w, "Unique").y1;
        near(first(w, "No:").y1 - unique, 15, 1);
        near(first(w, "Date").y1 - unique, 45, 1);
        near(first(w, "Place").y1 - unique, 75, 1);
        near(first(w, "Unilake").y1 - first(w, "Billed").y1, 15, 1);
      });

      it("has rows of the sample's height: item, Discount, Grand Total, then the notes", async () => {
        const w = await render();
        const item = first(w, "Aarav_Book_Alphabet").y1;
        const discount = first(w, "Discount").y1;
        const total = first(w, "Grand").y1;
        near(discount - item, 42.9);
        near(total - discount, 38.99, 0.6);
        near(first(w, "Declaration:").y1 - total, 32.2);
      });

      it("describes the book as <kid name>_Book_<book title>", async () => {
        const texts = (await render()).map((x) => x.text);
        expect(texts).toContain("Aarav_Book_Alphabet");
        expect(texts).toContain("Train");
        expect(texts).not.toContain("Aarav_Personalized");
      });

      it("cuts a title that cannot fit even at the smallest size, instead of running over the border", async () => {
        const huge = discounted();
        huge.orderSession.comic.title = Array.from(
          { length: 40 },
          (_, i) => `Adventure${i}`
        ).join(" ");
        const w = await render(huge);
        const inColumn = w.filter((x) => x.x1 > 67 && x.x2 < 298 && x.y1 < 300);
        expect(inColumn.length).toBeGreaterThan(0);
        for (const word of inColumn) {
          expect(word.y2).toBeLessThanOrEqual(281.89);
        }
        expect(inColumn.some((x) => x.text.endsWith("…"))).toBe(true);
      });

      it("embeds the Devanagari font for a Hindi book title, even when the customer's details are English", async () => {
        const hindi = discounted();
        hindi.orderSession.comic.title = "अलका की यात्रा";
        const dir = mkdtempSync(path.join(tmpdir(), "bill-fonts-"));
        try {
          const file = path.join(dir, "bill.pdf");
          writeFileSync(file, await renderBillOfSupplyPdf(hindi as never));
          const fonts = spawnSync("pdffonts", [file], { encoding: "utf8" });
          expect(fonts.stdout).toContain("NotoSansDevanagari");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("does not embed the Devanagari font for an English bill", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bill-fonts-"));
        try {
          const file = path.join(dir, "bill.pdf");
          writeFileSync(file, await renderBillOfSupplyPdf(discounted() as never));
          const fonts = spawnSync("pdffonts", [file], { encoding: "utf8" });
          expect(fonts.stdout).not.toContain("NotoSansDevanagari");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("cuts a title made of emoji without failing", async () => {
        const emoji = discounted();
        emoji.orderSession.comic.title = "🚂".repeat(100);
        const w = await render(emoji);
        const description = w.find((x) => x.text.startsWith("Aarav_Book_"))!;
        expect(description.text.endsWith("…")).toBe(true);
      });

      it("keeps a title with no spaces inside its column", async () => {
        const single = discounted();
        single.orderSession.comic.title = "A".repeat(200);
        const w = await render(single);
        const description = w.find((x) => x.text.startsWith("Aarav_Book_A"))!;
        expect(description.x2).toBeLessThanOrEqual(298);
        expect(description.text.endsWith("…")).toBe(true);
      });

      it("keeps a very long book title inside the item row, and the rest of the bill where it was", async () => {
        const long = discounted();
        long.orderSession.comic.title =
          "The Incredible Adventures of a Brave Little Explorer Who Travels Through Forests, Oceans, Deserts and Mountains";
        const w = await render(long);
        const plain = await render();

        const inRow = w.filter(
          (x) => x.y1 > 236 && x.y2 < 281 && x.x1 > 67 && x.x2 < 298
        );
        const description = ["Aarav_Book_The", "Mountains"];
        for (const text of description) {
          expect(inRow.map((x) => x.text)).toContain(text);
        }
        // Nothing below the item row moved.
        near(first(w, "Grand").y1, first(plain, "Grand").y1, 0.01);
        near(
          first(w, "Declaration:").y1,
          first(plain, "Declaration:").y1,
          0.01
        );
      });
    });
  }
);
