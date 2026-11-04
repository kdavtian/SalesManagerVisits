// The stock count PDF, layout 2 (owner, 2026-11-04): numbered rows, the signature block on EVERY page (signed once), "Էջ n/N" on a long
// list, the company name spelled "Քալանթարյան Ֆէմիլի ՓԲԸ".
import test from "node:test";
import assert from "node:assert/strict";
import { buildStockCountPdf, PDF_LAYOUT } from "../src/orders/stockCountPdf.js";
import { COMPANY_NAME } from "../src/orders/orderBlankPdf.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const items = (n) => Array.from({ length: n }, (_, i) => ({ name: `Edge 5w30 C3 #${i + 1}`, brand: "Castrol", size: "4L", expected_qty: 10, counted_qty: i % 7 ? 10 : 9, note: i === 3 ? "box damaged" : null }));
const base = { day: "2026-11-04", counter: "Ռուստամ Պետրոսյան", counterPosition: "Պահեստապետ", finishedAt: new Date(), auto: false, planned: 22, counted: 22, left_over: 0, signedAt: new Date(), attachmentImage: null, attachmentIsPdf: false };
const pages = (pdf) => (pdf.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const images = (pdf) => (pdf.toString("latin1").match(/\/Subtype \/Image/g) ?? []).length;

test("the company name is spelled Քալանթարյան Ֆէմիլի ՓԲԸ", () => {
  assert.equal(COMPANY_NAME, "Քալանթարյան Ֆէմիլի ՓԲԸ");
});

test("a short day is one page with the signature", async () => {
  const pdf = await buildStockCountPdf({ ...base, items: items(22), signaturePng: PNG });
  assert.ok(pdf.subarray(0, 4).toString() === "%PDF");
  assert.equal(pages(pdf), 1);
  assert.equal(images(pdf), 1);
});

test("a long list runs over several pages; the signature is embedded once and drawn on every page", async () => {
  const pdf = await buildStockCountPdf({ ...base, items: items(80), signaturePng: PNG, left_over: 3 });
  const n = pages(pdf);
  assert.ok(n >= 3, `pages: ${n}`);
  assert.equal(images(pdf), 1, "one embedded signature image (placed on every page)");
});

test("an automatically closed day (no signature) and a broken signature still give a PDF", async () => {
  assert.equal(pages(await buildStockCountPdf({ ...base, auto: true, counter: null, signedAt: null, items: items(3), signaturePng: null })), 1);
  assert.equal(pages(await buildStockCountPdf({ ...base, items: items(3), signaturePng: Buffer.from("not a png") })), 1);
});

test("the saved file name carries the layout, so an older PDF is made again", () => {
  assert.match(PDF_LAYOUT, /^L\d+$/);
});
