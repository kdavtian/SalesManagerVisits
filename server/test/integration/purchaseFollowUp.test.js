// Purchases follow-up (owner, 2026-11-26, roadmap PR 4): a late Ordered / On the way purchase gives a task once per expected date; the
// supplier scorecard of the last 12 months (on time, average delivery, differences, price change).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { checkLatePurchases } from "../../src/products/purchaseFollowUp.js";

const stamp = Date.now();
const supplierIds = [];
let users;
let cookies;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "accountant", "sales_manager"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'purchase_late' AND title LIKE $1", [`%ITEST-PF%`]);
  await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = ANY($1)", [supplierIds]);
  await pool.query("DELETE FROM suppliers WHERE id = ANY($1)", [supplierIds]);
  await cleanupAll();
  await stopTestServer();
});

async function supplier(name) {
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [`ITEST-PF ${name} ${stamp}`]);
  supplierIds.push(s.id);
  return s.id;
}
async function invoice(sid, { status, expected = null, arrivedDaysAgo = null, enteredDaysAgo = 0, createdBy = null, invoiceNo = null, invoiceDaysAgo = 0 }) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, expected_date, arrived_at, created_at, created_by)
     VALUES ($1, CURRENT_DATE - $2::int, $3, 400, $4, $5::date, CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END,
             now() - make_interval(days => $7::int), $8) RETURNING id`,
    [invoiceNo, invoiceDaysAgo, sid, status, expected, arrivedDaysAgo, enteredDaysAgo, createdBy]
  );
  return i.id;
}
const lateTasksOf = async (userId) =>
  (await pool.query("SELECT t.id, t.title, (SELECT count(*)::int FROM task_items WHERE task_id = t.id) AS items FROM tasks t WHERE auto_kind = 'purchase_late' AND assignee_id = $1 AND title LIKE '%ITEST-PF%' ORDER BY id", [userId])).rows;

test("a late purchase: one task to whoever entered it, once per expected date; a new date that passes again, a new task", async () => {
  const sid = await supplier("Late");
  const product = await createProduct();
  const id = await invoice(sid, { status: "ordered", expected: null, createdBy: users.accountant.id, invoiceNo: `ITEST-PF-L-${stamp}` });
  await pool.query("UPDATE purchase_invoices SET expected_date = CURRENT_DATE - 2 WHERE id = $1", [id]);
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'Edge 1L', 60, 3)", [id, product.id]);
  // not late yet, already received, or with a date ahead: nothing
  await invoice(sid, { status: "in_transit", expected: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), createdBy: users.accountant.id, invoiceNo: `ITEST-PF-T-${stamp}` });
  await invoice(sid, { status: "arrived", expected: "2020-01-01", arrivedDaysAgo: 1, createdBy: users.accountant.id, invoiceNo: `ITEST-PF-R-${stamp}` });

  await checkLatePurchases(new Date(), { force: true });
  let tasks = await lateTasksOf(users.accountant.id);
  assert.equal(tasks.length, 1, "one task for the one late purchase");
  assert.match(tasks[0].title, /ուշանում է/);
  assert.ok(tasks[0].items >= 2, "what to do + the products");
  await checkLatePurchases(new Date(), { force: true });
  assert.equal((await lateTasksOf(users.accountant.id)).length, 1, "not twice for the same expected date");
  // the supplier gave a new date, which passes too: a new task
  await pool.query("UPDATE purchase_invoices SET expected_date = CURRENT_DATE - 1 WHERE id = $1", [id]);
  await checkLatePurchases(new Date(), { force: true });
  tasks = await lateTasksOf(users.accountant.id);
  assert.equal(tasks.length, 2);
  // entered by someone who does not handle purchases (a sales manager): the accountants get it
  const other = await invoice(sid, { status: "ordered", expected: "2020-01-01", createdBy: users.sales_manager.id, invoiceNo: `ITEST-PF-O-${stamp}` });
  await checkLatePurchases(new Date(), { force: true });
  assert.equal((await lateTasksOf(users.sales_manager.id)).length, 0);
  assert.equal((await lateTasksOf(users.accountant.id)).length, 3, "the accountant got the sales manager's late purchase");
  assert.ok(other);
});

test("supplier scorecard: on time, average delivery, differences, price change; purchasing roles only", async () => {
  const sid = await supplier("Score");
  const p = await createProduct();
  // on time: entered 40 days ago, expected 5 days ago, received 6 days ago (lead 34)
  const a = await invoice(sid, { status: "arrived", expected: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), arrivedDaysAgo: 6, enteredDaysAgo: 40, invoiceNo: `ITEST-PF-A-${stamp}`, invoiceDaysAgo: 200 });
  // late: entered 60 days ago, expected 20 days ago, received 10 days ago (lead 50), one line short
  const b = await invoice(sid, { status: "arrived", expected: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), arrivedDaysAgo: 10, enteredDaysAgo: 60, invoiceNo: `ITEST-PF-B-${stamp}`, invoiceDaysAgo: 30 });
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd, received_qty) VALUES ($1, $2, 'x', 100, 2.00, 100)", [a, p.id]);
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd, received_qty) VALUES ($1, $2, 'x', 100, 2.20, 96)", [b, p.id]);
  assert.equal((await apiRequest("/api/purchases/scorecard", { cookie: cookies.sales_manager })).status, 403);
  const res = await apiRequest("/api/purchases/scorecard", { cookie: cookies.admin });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const sc = res.data[`itest-pf score ${stamp}`];
  assert.ok(sc, JSON.stringify(Object.keys(res.data)));
  assert.equal(sc.tracked, 2);
  assert.equal(sc.on_time_pct, 50);
  assert.equal(sc.avg_lead_days, 42, "(34 + 50) / 2");
  assert.equal(sc.received, 2);
  assert.equal(sc.diff_pct, 50);
  assert.equal(sc.price_change_pct, 10, "$2.00 -> $2.20");
  assert.equal(sc.price_products, 1);
});

// Review 2026-11-26: the form wiped the expected date whenever it saved a received purchase, so the scorecard lost it.
test("saving a purchase as received through the form keeps the date it was expected on", async () => {
  const p = await createProduct();
  const created = await apiRequest("/api/purchases", {
    method: "POST",
    cookie: cookies.accountant,
    body: { status: "ordered", invoice_date: new Date().toISOString().slice(0, 10), expected_date: "2026-01-10", supplier_name: `ITEST-PF Keep ${stamp}`, lines: [{ product_id: p.id, qty: 10, cost_usd: 1 }] },
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data));
  const id = created.data.id ?? created.data.invoice?.id;
  const { rows: [s] } = await pool.query("SELECT supplier_id FROM purchase_invoices WHERE id = $1", [id]);
  supplierIds.push(s.supplier_id);
  const saved = await apiRequest(`/api/purchases/${id}`, {
    method: "PUT",
    cookie: cookies.accountant,
    body: { status: "arrived", invoice_no: `ITEST-PF-K-${stamp}`, usd_rate: 400, invoice_date: new Date().toISOString().slice(0, 10), supplier_name: `ITEST-PF Keep ${stamp}`, lines: [{ product_id: p.id, qty: 10, cost_usd: 1 }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const { rows: [after] } = await pool.query("SELECT status, to_char(expected_date, 'YYYY-MM-DD') AS expected FROM purchase_invoices WHERE id = $1", [id]);
  assert.equal(after.status, "arrived");
  assert.equal(after.expected, "2026-01-10");
});

test("price change: a day's price is the average of its lines (two prices the same day do not tilt it)", async () => {
  const sid = await supplier("Same day");
  const p = await createProduct();
  for (const [k, daysAgo] of [[1, 100], [2, 10]]) {
    const i = await invoice(sid, { status: "arrived", arrivedDaysAgo: daysAgo, invoiceNo: `ITEST-PF-SD${k}-${stamp}`, invoiceDaysAgo: daysAgo });
    await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 10, 2.00), ($1, $2, 'x', 10, 2.20)", [i, p.id]);
  }
  const sc = (await apiRequest("/api/purchases/scorecard", { cookie: cookies.admin })).data[`itest-pf same day ${stamp}`];
  assert.equal(sc.price_change_pct, 0);
});
