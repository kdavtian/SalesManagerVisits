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
