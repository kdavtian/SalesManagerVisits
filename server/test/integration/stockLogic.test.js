// Stock logic review (owner, 2026-11-23): one definition of FREE stock everywhere a rep sells (orders/appStock.js freeStockSql), returns and
// purchases received back on the shelf count before the Excel has them, a packed order follows the 14-day Excel clock, two confirmations of the
// last pieces cannot both pass, and the Warehouse list shows the free stock with the Excel number beside it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;
const erpIds = [];
const supplierIds = [];
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["sales_director", "sales_manager", "warehouse_manager"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_purchase_lines WHERE invoice_no LIKE $1", [`ITEST-SL-%-${stamp}`]);
  await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = ANY($1)", [supplierIds]);
  await pool.query("DELETE FROM suppliers WHERE id = ANY($1)", [supplierIds]);
  await cleanupAll();
  await stopTestServer();
});

async function erpCustomer(suffix) {
  const erpId = `ITEST-SL-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 0, now())", [erpId]);
  // the Excel is up to date: its newest order is today, so the 14-day windows run on today's clock
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 1)", [erpId, `${erpId}-TODAY`]);
  return customer;
}
async function order(customer, product, quantity, cookie = cookies.sales_manager) {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity }], payment_method: "invoice" },
  });
  if (res.data?.id) trackOrder(res.data.id);
  return res;
}
const view = async (product) => (await apiRequest(`/api/products/${product.id}`, { cookie: cookies.sales_manager })).data;
async function arrivedPurchase(product, qty, { invoiceNo, received = qty } = {}) {
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [`ITEST-SL supplier ${stamp}-${supplierIds.length}`]);
  supplierIds.push(s.id);
  const { rows: [inv] } = await pool.query(
    "INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, arrived_at) VALUES ($1, CURRENT_DATE, $2, 400, 'arrived', now()) RETURNING id",
    [invoiceNo, s.id]
  );
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, received_qty, cost_usd) VALUES ($1, $2, 'x', $3, $4, 1)", [inv.id, product.id, qty, received]);
  return inv.id;
}

test("a good return back on the shelf is free stock again before the Excel has it", async () => {
  const customer = await erpCustomer("ret");
  const product = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 10 WHERE id = $1", [product.id]);
  const o = (await order(customer, product, 10)).data;
  // delivered in the app, not in the Excel yet: held
  await pool.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1", [o.id]);
  assert.equal((await view(product)).available_qty, 0);
  // all 10 come back in good condition, the return is done, the accountant has not entered it
  const { rows: [r] } = await pool.query(
    "INSERT INTO order_returns (order_id, customer_id, kind, status, reason, order_status_at_request) VALUES ($1, $2, 'return', 'done', 'other', 'delivered') RETURNING id",
    [o.id, customer.id]
  );
  await pool.query("INSERT INTO order_return_items (return_id, product_id, product_name, quantity, condition) VALUES ($1, $2, 'x', 10, 'good')", [r.id, product.id]);
  const p = await view(product);
  assert.equal(p.available_qty, 10, "the shelf has them again: free to sell");
  // the catalogue list says the same as the card
  const list = (await apiRequest("/api/products", { cookie: cookies.sales_manager })).data.find((x) => x.id === product.id);
  assert.equal(list.available_qty, 10);
  // marked by hand as entered in Excel (the accountant marks it after entering it): still added until the next sync
  await pool.query("UPDATE products SET synced_at = now() - interval '1 hour' WHERE id = $1", [product.id]);
  await pool.query("UPDATE order_returns SET recorded_at = now(), recorded_via = 'manual' WHERE id = $1", [r.id]);
  assert.equal((await view(product)).available_qty, 10, "no sync since the mark: the synced Excel stock cannot have it yet");
  // a sync after the mark: the Excel stock includes it now, not added twice
  await pool.query("UPDATE products SET synced_at = now() WHERE id = $1", [product.id]);
  assert.equal((await view(product)).available_qty, 0);
});

test("a purchase received in the app is free stock until the Excel shows its invoice", async () => {
  const customer = await erpCustomer("arr");
  const product = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [product.id]);
  const invoiceNo = `ITEST-SL-INV-${stamp}`;
  // the bot sends Excel purchases (some other invoice is there): the invoice match decides
  await pool.query("INSERT INTO erp_purchase_lines (invoice_no, invoice_date, qty) VALUES ($1, CURRENT_DATE - 30, 1)", [`ITEST-SL-OTHER-${stamp}`]);
  const blocked = await order(customer, product, 2);
  assert.equal(blocked.status, 409, "nothing on the shelf yet");
  assert.equal(blocked.data.code, "out_of_stock");
  await arrivedPurchase(product, 12, { invoiceNo, received: 11 });
  assert.equal((await view(product)).available_qty, 11, "received 11 of 12: the received quantity counts");
  const ok = await order(customer, product, 2);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  // the accountant entered the invoice in Excel (same number, written differently, same date): the Excel stock has it now, no double count
  await pool.query("INSERT INTO erp_purchase_lines (invoice_no, invoice_date, qty) VALUES ($1, CURRENT_DATE, 11)", [`  ${invoiceNo.toLowerCase()} `]);
  assert.equal((await view(product)).available_qty, 0);
});

test("a received purchase stops counting once the Excel stock changed after it, or when its invoice is old (never stock that is not there)", async () => {
  const product = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 0, stock_changed_at = now() - interval '1 day' WHERE id = $1", [product.id]);
  const inv = await arrivedPurchase(product, 6, { invoiceNo: null });
  assert.equal((await view(product)).available_qty, 6, "no number, no Excel match yet: counted");
  // the Excel stock changed after the goods arrived: the accountant may have entered the invoice under another number -- not added again
  await pool.query("UPDATE products SET stock_qty = 6, stock_changed_at = now() WHERE id = $1", [product.id]);
  assert.equal((await view(product)).available_qty, 6, "6 from the Excel, not 12");
  // an old invoice typed in afterwards (dated 20 days ago) is taken as already in the Excel
  const other = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [other.id]);
  const old = await arrivedPurchase(other, 4, { invoiceNo: `ITEST-SL-OLD-${stamp}` });
  await pool.query("UPDATE purchase_invoices SET invoice_date = CURRENT_DATE - 20 WHERE id = $1", [old]);
  assert.equal((await view(other)).available_qty, 0);
  assert.ok(inv);
});

test("a packed order the sync never moved to delivered stops holding after 14 days of the Excel clock", async () => {
  const customer = await erpCustomer("pack");
  const product = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 8 WHERE id = $1", [product.id]);
  const o = (await order(customer, product, 5)).data;
  await pool.query("UPDATE orders SET status = 'packed_stock_out', updated_at = now() WHERE id = $1", [o.id]);
  assert.equal((await view(product)).available_qty, 3, "packed today (no history yet: its last change): held");
  // packed 20 days ago (the audit log is append-only: the old packing is written as it happened)
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'confirmed', 'packed_stock_out', now() - interval '20 days')", [o.id]);
  await pool.query("UPDATE orders SET updated_at = now() - interval '20 days' WHERE id = $1", [o.id]);
  assert.equal((await view(product)).available_qty, 8, "taken as already in the Excel stock, like an unmatched delivery");
});

test("two confirmations of the last pieces at the same moment: only one passes", async () => {
  const customer = await erpCustomer("race");
  const product = await createProduct();
  await pool.query("UPDATE products SET stock_qty = 5 WHERE id = $1", [product.id]);
  const a = (await order(customer, product, 5)).data;
  const b = (await order(customer, product, 5)).data;
  const confirm = (id) => apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  const results = await Promise.all([confirm(a.id), confirm(b.id)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.data?.error ?? r.data?.status)));
  assert.equal(results.find((r) => r.status === 409).data.code, "short_stock");
  assert.equal((await view(product)).available_qty, 0);
});

test("the Warehouse list shows free stock beside the Excel number; nothing free is 'out' even with stock in Excel", async () => {
  const customer = await erpCustomer("inv");
  const product = await createProduct({ name: `ITEST-SL inventory ${stamp}` });
  await pool.query("UPDATE products SET stock_qty = 40 WHERE id = $1", [product.id]);
  const o = (await order(customer, product, 38)).data;
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o.id]);
  const res = await apiRequest(`/api/warehouse/inventory?q=${encodeURIComponent(product.name)}`, { cookie: cookies.warehouse_manager });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const row = res.data.find((x) => x.id === product.id);
  assert.equal(row.stock_qty, 40, "the Excel number");
  assert.equal(row.available_qty, 2, "free: 40 − 38 held");
  await pool.query("UPDATE order_items SET quantity = 40 WHERE order_id = $1", [o.id]);
  const out = (await apiRequest(`/api/warehouse/inventory?q=${encodeURIComponent(product.name)}&stock=out_of_stock`, { cookie: cookies.warehouse_manager })).data;
  assert.equal(out.find((x) => x.id === product.id)?.stock_status, "out", "all 40 held: out of stock, in the Out of stock filter");
  // the pick list and the warehouse shortage count the shelf: confirmed goods are still on it
  const pick = (await apiRequest("/api/warehouse/pick-list", { cookie: cookies.warehouse_manager })).data.find((x) => x.product_id === product.id);
  assert.equal(pick.stock_qty, 40);
});
