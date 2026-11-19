// Owner, 2026-11-07: the Purchases module types supplier invoices in the app and checks them, invoice by invoice, against the Excel
// Purchase_IN rows the bot sends. Isolated: the bot's push replaces the whole Excel copy (isolated-tests.txt).
process.env.ERP_SYNC_KEY = "itest-sync-key";
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let accCookie, repCookie, p1, p2;
test.before(async () => {
  await startTestServer();
  accCookie = await loginAs((await createUser("accountant")).email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
  p1 = await createProduct({ unit: "4L" });
  p2 = await createProduct({ unit: "208L" });
});
test.after(async () => {
  await pool.query("DELETE FROM purchase_invoices");
  await pool.query("DELETE FROM suppliers");
  await pool.query("DELETE FROM erp_purchase_lines");
  await cleanupAll();
  await stopTestServer();
});

const push = (rows) => apiRequest("/api/erp-sync/purchases", { method: "POST", body: { rows }, headers: { "X-Sync-Key": "itest-sync-key" } });

test("a rep cannot open Purchases; the accountant types an invoice (new supplier on the way), a repeated send makes no second one", async () => {
  assert.equal((await apiRequest("/api/purchases", { cookie: repCookie })).status, 403);
  const body = { invoice_no: "3/26", invoice_date: "2026-09-17", supplier_name: "Sole Trans", usd_rate: 385, client_ref: "itest-p-1", lines: [{ product_id: p1.id, qty: 100, cost_usd: 15.24 }, { product_id: p2.id, qty: 2, cost_usd: 900 }] };
  const bad = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { ...body, lines: [{ product_id: p1.id, qty: 0, cost_usd: 1 }] } });
  assert.equal(bad.status, 400);
  const r = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.supplier, "Sole Trans");
  assert.equal(r.data.lines.length, 2);
  assert.equal(r.data.lines[0].size_l, 4); // from the product's "4L"
  const again = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body });
  assert.equal(again.data.id, r.data.id);
  const suppliers = await apiRequest("/api/purchases/suppliers", { cookie: accCookie });
  assert.equal(suppliers.data.suppliers.filter((s) => s.name === "Sole Trans").length, 1);
  assert.equal(suppliers.data.suppliers.find((s) => s.name === "Sole Trans").last_usd_rate, 385);
});

test("side by side with Excel: match, different, only in the app, only in Excel", async () => {
  const sync = await push([
    { invoice_id: "3/26 ", date: "2026-09-17", supplier: "Sole Trans", product_id: "X1", qty: 100, cost_usd: 15.24, amount_amd: 586740, excel_row: 1 },
    { invoice_id: "3/26", date: "2026-09-17", supplier: "Sole Trans", product_id: "X2", qty: 2, cost_usd: 900, excel_row: 2 },
    { invoice_id: "KAL 1/24", date: "2026-08-01", supplier: "Luk Oil", product_id: "R1", qty: 10, cost_usd: 50, excel_row: 3 },
    { invoice_id: "", date: "2026-08-01", qty: 1, excel_row: 4 },
  ]);
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.rows, 3);
  assert.equal(sync.data.skipped, 1);
  await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "77", invoice_date: "2026-09-20", supplier_name: "Orlen Oil", usd_rate: 385, lines: [{ product_id: p1.id, qty: 5, cost_usd: 10 }] } });
  let list = (await apiRequest("/api/purchases?from=2026-08-01&to=2026-09-30", { cookie: accCookie })).data;
  const by = Object.fromEntries(list.map((x) => [x.invoice_no.trim(), x]));
  assert.equal(by["3/26"].status, "match");
  assert.equal(by["77"].status, "app_only");
  assert.equal(by["KAL 1/24"].status, "excel_only");
  assert.equal(by["KAL 1/24"].usd, 500);
  // a different number of packs in the app -> "diff", and the invoice shows the Excel lines beside its own
  const id = by["3/26"].id;
  const full = (await apiRequest(`/api/purchases/${id}`, { cookie: accCookie })).data;
  await apiRequest(`/api/purchases/${id}`, { method: "PUT", cookie: accCookie, body: { ...full, lines: full.lines.map((l, i) => ({ ...l, qty: i === 0 ? 99 : l.qty })) } });
  list = (await apiRequest("/api/purchases?from=2026-09-01", { cookie: accCookie })).data;
  assert.equal(list.find((x) => x.id === id).status, "diff");
  assert.equal((await apiRequest(`/api/purchases/${id}`, { cookie: accCookie })).data.excel_lines.length, 2);
});

// review 2026-11-20 (P1 "fix the numbers")
test("USD per litre leaves out lines without litres; two suppliers' invoices with one number and date stay two; a line without a product keeps its name and litres", async () => {
  const stand = await createProduct({ unit: "pcs" });
  await push([
    { invoice_id: "5/26", date: "2026-10-05", supplier: "Sole Trans", product_id: "A1", size_l: 4, qty: 10, cost_usd: 20, excel_row: 1 },
    { invoice_id: "5/26", date: "2026-10-05", supplier: "Luk Oil", product_id: "B1", size_l: 1, qty: 30, cost_usd: 3, excel_row: 2 },
  ]);
  // the app: Sole Trans 5/26 (oil + a stand) and Orlen 5/26, the same number and day
  const sole = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "5/26", invoice_date: "2026-10-05", supplier_name: "Sole Trans", usd_rate: 385, lines: [{ product_id: p1.id, qty: 10, cost_usd: 20 }, { product_id: stand.id, qty: 5, cost_usd: 40 }] } });
  assert.equal(sole.status, 201, JSON.stringify(sole.data));
  const orlen = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "5/26", invoice_date: "2026-10-05", supplier_name: "Orlen Oil", usd_rate: 385, lines: [{ product_id: p1.id, qty: 1, cost_usd: 10 }] } });
  assert.equal(orlen.status, 201, JSON.stringify(orlen.data));
  const list = (await apiRequest("/api/purchases?from=2026-10-01&to=2026-10-31", { cookie: accCookie })).data.filter((x) => x.invoice_no.trim() === "5/26");
  assert.equal(list.length, 3, "Sole Trans (app + Excel), Orlen (app only), Luk Oil (Excel only)");
  const soleRow = list.find((x) => x.id === sole.data.id);
  assert.equal(soleRow.excel?.qty, 10, "paired with the Sole Trans Excel invoice, not Luk Oil's");
  assert.equal(soleRow.usd, 400);
  assert.equal(soleRow.liquid_usd, 200, "the stand's $200 is not oil");
  assert.equal(soleRow.liters, 40);
  assert.ok(list.some((x) => x.id === orlen.data.id && x.status === "app_only"));
  assert.ok(list.some((x) => x.status === "excel_only" && x.supplier === "Luk Oil"));
  // a line without a catalogue product (an Excel line the app does not know): saved with its own name, brand and litres
  const loose = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "6/26", invoice_date: "2026-10-06", supplier_name: "Sole Trans", usd_rate: 385, lines: [{ product_id: null, product_name: "Castrol Unknown 5W-30", brand: "Castrol", size_l: 4, qty: 3, cost_usd: 12 }] } });
  assert.equal(loose.status, 201, JSON.stringify(loose.data));
  assert.deepEqual([loose.data.lines[0].product_name, loose.data.lines[0].brand, loose.data.lines[0].size_l], ["Castrol Unknown 5W-30", "Castrol", 4]);
  // editing it back unchanged works (it used to fail "Every line needs a product")
  const again = await apiRequest(`/api/purchases/${loose.data.id}`, { method: "PUT", cookie: accCookie, body: { ...loose.data, lines: loose.data.lines.map((l) => ({ product_id: null, product_name: l.product_name, brand: l.brand, size_l: l.size_l, qty: l.qty, cost_usd: l.cost_usd })) } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
});

test("an invoice's Excel lines are that supplier's when two suppliers share the number and date", async () => {
  const list = (await apiRequest("/api/purchases?from=2026-10-01&to=2026-10-31", { cookie: accCookie })).data;
  const sole = list.find((x) => x.invoice_no.trim() === "5/26" && x.supplier === "Sole Trans" && x.id);
  const full = (await apiRequest(`/api/purchases/${sole.id}`, { cookie: accCookie })).data;
  assert.deepEqual(full.excel_lines.map((l) => l.supplier), ["Sole Trans"]);
  const luk = (await apiRequest(`/api/purchases/excel-invoice?invoice_no=5%2F26&date=2026-10-05&supplier=Luk%20Oil`, { cookie: accCookie })).data;
  assert.deepEqual(luk.map((l) => l.supplier), ["Luk Oil"]);
});

test("a supplier filter does not pair an invoice with another supplier's Excel lines; a sheet never mixes two other suppliers", async () => {
  await push([
    { invoice_id: "8/26", date: "2026-10-08", supplier: "Y Ltd", product_id: "C1", size_l: 1, qty: 7, cost_usd: 2, excel_row: 1 },
    { invoice_id: "9/26", date: "2026-10-09", supplier: "X LLC", product_id: "D1", size_l: 1, qty: 1, cost_usd: 1, excel_row: 2 },
    { invoice_id: "9/26", date: "2026-10-09", supplier: "Z Co", product_id: "D2", size_l: 1, qty: 2, cost_usd: 1, excel_row: 3 },
  ]);
  const mk = (no, date, supplier) => apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: no, invoice_date: date, supplier_name: supplier, usd_rate: 385, lines: [{ product_id: p1.id, qty: 1, cost_usd: 1 }] } });
  const x8 = (await mk("8/26", "2026-10-08", "X Trade")).data;
  await mk("8/26", "2026-10-08", "Y Trade");
  const xId = x8.supplier_id;
  const filtered = (await apiRequest(`/api/purchases?from=2026-10-08&to=2026-10-08&supplier_id=${xId}`, { cookie: accCookie })).data;
  assert.equal(filtered.find((r) => r.id === x8.id).status, "app_only", "not paired with Y's Excel lines");
  const x9 = (await mk("9/26", "2026-10-09", "X Trade")).data;
  const full = (await apiRequest(`/api/purchases/${x9.id}`, { cookie: accCookie })).data;
  assert.deepEqual(full.excel_lines, [], "two other suppliers' lines are not mixed into this invoice");
});
