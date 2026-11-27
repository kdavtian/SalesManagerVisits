// Smart purchase suggestions (owner, 2026-11-25): per supplier, in whole steps (bottles 5 boxes, 20 L 5 pieces, above 20 L by 1), with stock
// now, on the way, the order, stock and days left after receiving (lead time and cover days from the settings).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
const erpIds = [];
const supplierIds = [];
let cookies;

test.before(async () => {
  await startTestServer();
  cookies = {};
  for (const role of ["admin", "sales_manager"]) cookies[role] = await loginAs((await createUser(role)).email);
  await pool.query("UPDATE app_settings SET demand_lead_time_days = 45, demand_cover_days = 45 WHERE id = 1");
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE product_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = ANY($1)", [supplierIds]);
  await pool.query("DELETE FROM suppliers WHERE id = ANY($1)", [supplierIds]);
  await cleanupAll();
  await stopTestServer();
});

// a product with an ERP id that sold `perWeek` pieces every week of the last half year
async function selling(name, unit, perWeek, { itemsPerPack = null, stock = 0 } = {}) {
  const p = await createProduct({ name: `${name} ${stamp}` });
  const erpId = `ITEST-PS-${erpIds.length}-${stamp}`;
  erpIds.push(erpId);
  await pool.query("UPDATE products SET erp_product_id = $2, unit = $3, items_per_pack = $4, stock_qty = $5, created_at = now() - interval '2 years' WHERE id = $1", [p.id, erpId, unit, itemsPerPack, stock]);
  for (let w = 0; w < 26; w += 1) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ('ITEST-PS', $1, CURRENT_DATE - $2::int, $3, $4, 1)", [`ITEST-PS-${erpId}-${w}`, w * 7 + 1, erpId, perWeek]);
  }
  return p;
}
async function boughtFrom(product, supplierName, costUsd) {
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [supplierName]);
  const sid = s?.id ?? (await pool.query("SELECT id FROM suppliers WHERE lower(name) = lower($1)", [supplierName])).rows[0].id;
  if (!supplierIds.includes(sid)) supplierIds.push(sid);
  const { rows: [inv] } = await pool.query(
    "INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, arrived_at) VALUES ($1, CURRENT_DATE - 100, $2, 400, 'arrived', now() - interval '100 days') RETURNING id",
    [`ITEST-PS-INV-${product.id}`, sid]
  );
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 60, $3)", [inv.id, product.id, costUsd]);
}

test("suggestions: per supplier, whole steps, stock and days after receiving", async () => {
  const supplier = `ITEST-PS Supplier ${stamp}`;
  const oil = await selling("ITEST-PS Edge 1L", "1L", 14, { itemsPerPack: 12, stock: 40 }); // 2 a day
  await boughtFrom(oil, supplier, 3.5);
  const can = await selling("ITEST-PS Edge 20L", "20L", 1, { stock: 0 }); // 1 a week
  await boughtFrom(can, supplier, 70);

  assert.equal((await apiRequest("/api/purchases/suggestions", { cookie: cookies.sales_manager })).status, 403, "purchasing roles only");
  const res = await apiRequest("/api/purchases/suggestions", { cookie: cookies.admin });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.lead_time_days, 45);
  assert.equal(res.data.cover_days, 45);
  const group = res.data.suppliers.find((g) => g.supplier === supplier);
  assert.ok(group, "the supplier the products were last bought from");
  const o = group.lines.find((l) => l.product_id === oil.id);
  assert.equal(o.stock_now, 40);
  assert.ok(Math.abs(o.daily_demand - 2) < 0.01);
  assert.equal(o.days_now, 20);
  assert.equal(o.step_pieces, 60, "5 boxes of 12");
  assert.equal(o.order % 60, 0, "whole steps of 5 boxes");
  assert.ok(o.order >= 60 * 2 && o.order <= 60 * 3, `2 a day x 90 days - 40 = 140 (+ safety stock): ${o.order}`);
  assert.equal(o.runs_out_before_arrival, true, "40 last 20 days, the goods come in 45");
  assert.equal(o.stock_at_arrival, 0);
  assert.equal(o.after_receiving, o.order);
  assert.equal(o.days_after_receiving, Math.round((o.order / 2) * 10) / 10);
  assert.equal(o.cost_usd, 3.5);
  const c = group.lines.find((l) => l.product_id === can.id);
  assert.equal(c.kind, "canister");
  assert.equal(c.step_pieces, 5);
  assert.equal(c.order % 5, 0, "20 L in steps of 5 pieces");
  assert.equal(group.totals.pieces, o.order + c.order);
  assert.equal(group.totals.usd, Math.round((o.order * 3.5 + c.order * 70) * 100) / 100);
  assert.equal(group.totals.liters, o.order * 1 + c.order * 20);
  // the cover-days setting changes the horizon
  await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { demand_cover_days: 90 } });
  const longer = (await apiRequest("/api/purchases/suggestions", { cookie: cookies.admin })).data.suppliers.find((g) => g.supplier === supplier).lines.find((l) => l.product_id === oil.id);
  assert.ok(longer.order > o.order, `135 days of cover buys more: ${longer.order} > ${o.order}`);
  await pool.query("UPDATE app_settings SET demand_cover_days = 45 WHERE id = 1");
});

test("enough stock or already on the way: no suggestion", async () => {
  const full = await selling("ITEST-PS Full 4L", "4L", 7, { itemsPerPack: 4, stock: 1000 });
  const coming = await selling("ITEST-PS Coming 4L", "4L", 7, { itemsPerPack: 4, stock: 0 });
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [`ITEST-PS Coming ${stamp}`]);
  supplierIds.push(s.id);
  const { rows: [inv] } = await pool.query("INSERT INTO purchase_invoices (invoice_date, supplier_id, status) VALUES (CURRENT_DATE, $1, 'ordered') RETURNING id", [s.id]);
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 400, 1)", [inv.id, coming.id]);
  const all = (await apiRequest("/api/purchases/suggestions", { cookie: cookies.admin })).data.suppliers.flatMap((g) => g.lines);
  assert.equal(all.find((l) => l.product_id === full.id), undefined, "1000 last far beyond 90 days");
  assert.equal(all.find((l) => l.product_id === coming.id), undefined, "400 already ordered cover 1 a day for 90 days");
});

// Owner, 2026-11-26: "Sole Trans is the transporter. Real company: Castrol" -- a transporter's goods are suggested under the real supplier,
// the card naming the transporter (via); the migration marks Sole Trans as bringing Castrol.
test("suggestions: a transporter's products are under the real supplier, via the transporter", async () => {
  const { rows: [sole] } = await pool.query("SELECT goods_from FROM suppliers WHERE lower(name) = 'sole trans'");
  assert.equal(sole?.goods_from, "Castrol", "migration 226 marks Sole Trans");
  const transporter = `ITEST-PS Trans ${stamp}`;
  const real = `ITEST-PS Real ${stamp}`;
  const oil = await selling("ITEST-PS Via 1L", "1L", 14, { itemsPerPack: 12, stock: 0 });
  await boughtFrom(oil, transporter, 3);
  await pool.query("UPDATE suppliers SET goods_from = $2 WHERE lower(name) = lower($1)", [transporter, real]);
  const res = await apiRequest("/api/purchases/suggestions", { cookie: cookies.admin });
  assert.equal(res.status, 200);
  assert.ok(!res.data.suppliers.some((g) => g.supplier === transporter), "no card for the transporter");
  const card = res.data.suppliers.find((g) => g.supplier === real);
  assert.ok(card, JSON.stringify(res.data.suppliers.map((g) => g.supplier)));
  assert.deepEqual(card.via, [transporter]);
  const line = card.lines.find((l) => l.product_id === oil.id);
  assert.equal(line.via, transporter);
  assert.equal(line.supplier, real);
});

// Owner, 2026-11-26 (step 2): the screen's "what if" -- other lead time / cover days for one answer; the settings stay; nonsense is ignored.
test("suggestions: what if (lead_days / cover_days) for this answer only", async () => {
  const res = await apiRequest("/api/purchases/suggestions?lead_days=60&cover_days=30", { cookie: cookies.admin });
  assert.equal(res.status, 200);
  assert.equal(res.data.lead_time_days, 60);
  assert.equal(res.data.cover_days, 30);
  assert.equal(res.data.settings_lead_days, 45);
  assert.equal(res.data.settings_cover_days, 45);
  const bad = await apiRequest("/api/purchases/suggestions?lead_days=0&cover_days=abc", { cookie: cookies.admin });
  assert.equal(bad.data.lead_time_days, 45);
  assert.equal(bad.data.cover_days, 45);
  const { rows: [s] } = await pool.query("SELECT demand_lead_time_days, demand_cover_days FROM app_settings WHERE id = 1");
  assert.deepEqual([s.demand_lead_time_days, s.demand_cover_days], [45, 45], "the settings are not changed");
});
