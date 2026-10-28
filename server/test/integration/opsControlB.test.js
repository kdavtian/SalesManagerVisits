// Operations control part 2: price realization, USD/AMD review, dead stock, win-back, order flow, data scorecard, daily jobs.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { runOpsJobs } from "../../src/reports/opsJobs.js";

let admin, director, accountant, rep, directorCookie, accountantCookie, repCookie, customer, product, slow;
const stamp = Date.now();
const CH = `OPSCH-${stamp}`;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  rep = await createUser("sales_manager");
  [directorCookie, accountantCookie, repCookie] = await Promise.all([director, accountant, rep].map((u) => loginAs(u.email)));
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `OPSB-${stamp}` });
  product = await createProduct({ unit: "4L" });
  await pool.query("UPDATE products SET erp_product_id = $2, silver_price_amd = 20000, bronze_price_amd = 22000, gold_price_amd = 18000, unit_price_amd = 22000, landing_cost_amd = 12000, stock_qty = 10, created_at = now() - interval '120 days' WHERE id = $1", [product.id, `OPSB-P-${stamp}`]);
  slow = await createProduct({ unit: "1L" });
  await pool.query("UPDATE products SET erp_product_id = $2, silver_price_amd = 5000, bronze_price_amd = 5500, unit_price_amd = 5500, landing_cost_amd = 3000, stock_qty = 10, created_at = now() - interval '120 days' WHERE id = $1", [slow.id, `OPSB-S-${stamp}`]);
  await pool.query("DELETE FROM fx_rates");
});
test.after(async () => {
  await pool.query("DELETE FROM fx_rates");
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [`OPSB-${stamp}`]);
  await pool.query("DELETE FROM tasks WHERE auto_kind IN ('fx_review', 'dead_stock', 'excel_upload', 'data_quality', 'reorder_followup') AND (assignee_id = ANY($1) OR customer_id = $2)", [[admin.id, director.id, accountant.id, rep.id], customer.id]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [`OPSB-${stamp}`]);
  await cleanupAll();
  await stopTestServer();
});

const openTasks = async (kind, userId) => (await pool.query("SELECT id, title FROM tasks WHERE auto_kind = $1 AND assignee_id = $2 AND status = 'open'", [kind, userId])).rows;

test("only management reads the console", async () => {
  for (const path of ["margin", "stock", "customers", "flow", "data"]) assert.equal((await apiRequest(`/api/ops/${path}`, { cookie: repCookie })).status, 403, path);
});

test("price realization by channel; sales below landing cost are listed", async () => {
  const line = (orderId, qty, revenue) =>
    pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, sales_rep)
       VALUES ($1, $2, current_date - 5, $3, 'Castrol', 'x', '4', $4, $5, $6, $7)`,
      [`OPSB-${stamp}`, `OPSB-O-${stamp}-${orderId}`, `OPSB-P-${stamp}`, qty, revenue / qty, revenue, CH]
    );
  await line(1, 10, 180000); // 18,000 each: 90 % of Silver 20,000, margin (18000-12000)/18000
  await line(2, 2, 20000); // 10,000 each: below the 12,000 landing cost
  const res = await apiRequest("/api/ops/margin?days=30", { cookie: directorCookie });
  assert.equal(res.status, 200);
  const ch = res.data.realization.channels.find((c) => c.channel === CH);
  assert.ok(ch);
  assert.equal(ch.lines, 2);
  assert.equal(ch.revenue_amd, 200000);
  assert.equal(ch.realization_pct, Math.round((200000 / (12 * 20000)) * 1000) / 10);
  assert.equal(ch.below_landing_lines, 1);
  const worst = res.data.realization.below_landing.find((w) => w.order_id === `OPSB-O-${stamp}-2`);
  assert.ok(worst);
  assert.equal(worst.loss, 4000);
});

test("USD/AMD: drift from the last reviewed rate triggers review tasks; 'review done' resets it", async () => {
  assert.equal((await apiRequest("/api/ops/fx", { method: "POST", cookie: directorCookie, body: { rate: 385 } })).status, 403, "a sales director cannot set the rate");
  assert.equal((await apiRequest("/api/ops/fx", { method: "POST", cookie: accountantCookie, body: { rate: 5 } })).status, 400);
  const first = await apiRequest("/api/ops/fx", { method: "POST", cookie: accountantCookie, body: { rate: 385 } });
  assert.equal(first.data.needs_review, false);
  const small = await apiRequest("/api/ops/fx", { method: "POST", cookie: accountantCookie, body: { rate: 390 } });
  assert.equal(small.data.needs_review, false, "1.3 % is under the 2 % trigger");
  const big = await apiRequest("/api/ops/fx", { method: "POST", cookie: accountantCookie, body: { rate: 396 } });
  assert.equal(big.data.needs_review, true);
  assert.ok(big.data.drift_pct > 2);
  assert.equal((await openTasks("fx_review", director.id)).length, 1, "the sales director gets a review task");
  assert.equal((await openTasks("fx_review", accountant.id)).length, 1);
  const done = await apiRequest("/api/ops/fx/review-done", { method: "POST", cookie: directorCookie });
  assert.equal(done.data.needs_review, false);
  assert.equal(done.data.drift_pct, 0);
  assert.equal((await openTasks("fx_review", director.id)).length, 0, "closed with the review");
});

test("dead stock: stock with no sale for 180 days is listed with its value; a decision creates the task", async () => {
  const res = await apiRequest("/api/ops/stock", { cookie: directorCookie });
  const row = res.data.items.find((i) => i.product_id === slow.id);
  assert.ok(row, "listed");
  assert.equal(row.value_landing_amd, 30000);
  assert.equal(res.data.can_decide, true);
  assert.equal((await apiRequest(`/api/ops/stock/${slow.id}`, { method: "PUT", cookie: accountantCookie, body: { action: "campaign" } })).status, 403);
  assert.equal((await apiRequest(`/api/ops/stock/${slow.id}`, { method: "PUT", cookie: directorCookie, body: { action: "nonsense" } })).status, 400);
  const saved = await apiRequest(`/api/ops/stock/${slow.id}`, { method: "PUT", cookie: directorCookie, body: { action: "campaign", note: "-10 %", assignee_id: rep.id } });
  assert.equal(saved.status, 200);
  assert.ok(saved.data.task_id);
  assert.equal((await openTasks("dead_stock", rep.id)).length, 1);
  const again = (await apiRequest("/api/ops/stock", { cookie: directorCookie })).data.items.find((i) => i.product_id === slow.id);
  assert.equal(again.action, "campaign");
  assert.equal(again.assignee_name != null, true);
  // a recent sale takes it off the list (dated by the YEREVAN day: after 20:00 UTC Yerevan is already on the next date, and the win-back test below compares against the task's Yerevan date)
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, qty, unit_price_amd, revenue_amd, sales_rep) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - 3, $3, 'Castrol', 'x', 1, 1, 1, $4)", [`OPSB-${stamp}`, `OPSB-O-${stamp}-9`, `OPSB-S-${stamp}`, CH]);
  assert.equal((await apiRequest("/api/ops/stock", { cookie: directorCookie })).data.items.some((i) => i.product_id === slow.id), false);
});

test("win-back: a lapsed-customer task counts as returned when the customer orders afterwards", async () => {
  const task = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind, created_at) VALUES ('wb', $1, $2, $3, current_date, true, 'reorder_followup', now() - interval '3 days') RETURNING id",
    [director.id, rep.id, customer.id]
  );
  const res = await apiRequest("/api/ops/customers", { cookie: directorCookie });
  assert.equal(res.status, 200);
  const mine = res.data.by_rep.find((r) => r.label === rep.name);
  assert.ok(mine);
  assert.equal(mine.created >= 1, true);
  assert.equal(mine.returned >= 1, true, "the ERP line of 3 days ago is after the task was created 3 days + a bit ago? (order_date >= task date)");
  assert.equal(typeof res.data.lapsed_customers, "number");
  await pool.query("DELETE FROM tasks WHERE id = $1", [task.rows[0].id]);
});

test("order flow: step timings and orders waiting longer than the SLA", async () => {
  const o = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "cash", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(o.status, 201);
  trackOrder(o.data.id);
  await pool.query("UPDATE orders SET created_at = now() - interval '10 hours', status = 'submitted', approval_status = 'not_required' WHERE id = $1", [o.data.id]);
  // limit=500: the list holds the 40 longest-waiting orders by default, and other test files leave older waiting orders in the shared database
  const res = await apiRequest("/api/ops/flow?days=30&limit=500", { cookie: directorCookie });
  assert.equal(res.status, 200);
  const waiting = res.data.waiting.find((w) => w.id === o.data.id);
  assert.ok(waiting);
  assert.equal(waiting.step, "confirm");
  assert.equal(waiting.over_sla, true, "10 h waiting is over the 4 h confirm SLA");
  assert.ok(waiting.waiting_h >= 9.9);
  assert.equal(res.data.sla.confirm, 4);
  assert.ok(res.data.over_sla_count >= 1);
  // a confirmed order with history gives a confirm-step timing
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'submitted', 'confirmed', now() - interval '6 hours')", [o.data.id]);
  const after = await apiRequest("/api/ops/flow?days=30", { cookie: directorCookie });
  assert.ok(after.data.steps.confirm.n >= 1);
});

test("data scorecard lists the fixes; the daily jobs create the accountant's Excel and data tasks once and close them", async () => {
  await pool.query("UPDATE products SET name = 'Test Oil ' || id WHERE id = $1", [product.id]);
  const card = await apiRequest("/api/ops/data", { cookie: directorCookie });
  const t = card.data.checks.find((c) => c.key === "products_test_active");
  assert.ok(t.count >= 1);
  assert.equal(t.severity, "fix");
  assert.ok(card.data.checks.find((c) => c.key === "customers_no_phone"));

  // a Monday at 11:00 Yerevan, the workbook has not arrived today
  const monday = new Date(Date.UTC(2026, 9, 12, 7, 0));
  await pool.query("DELETE FROM tasks WHERE auto_kind IN ('excel_upload', 'data_quality')");
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 0, $2) ON CONFLICT (erp_customer_id) DO UPDATE SET synced_at = EXCLUDED.synced_at", [`OPSB-${stamp}`, new Date(Date.UTC(2026, 9, 9, 8, 0))]);
  const first = await runOpsJobs(monday);
  assert.ok(first.excelTasks >= 1);
  assert.equal((await openTasks("excel_upload", accountant.id)).length, 1);
  assert.ok(first.dataTasks >= 1);
  const second = await runOpsJobs(monday);
  assert.equal(second.excelTasks, 0, "one open task, no spam");
  // the workbook arrives -> the task closes itself
  await pool.query("UPDATE erp_customer_data SET synced_at = $1 WHERE erp_customer_id = $2", [new Date(Date.UTC(2026, 9, 12, 6, 30)), `OPSB-${stamp}`]);
  await runOpsJobs(monday);
  assert.equal((await openTasks("excel_upload", accountant.id)).length, 0);
  // not on a Sunday
  const sunday = new Date(Date.UTC(2026, 9, 11, 8, 0));
  await pool.query("DELETE FROM tasks WHERE auto_kind IN ('excel_upload', 'data_quality')");
  assert.deepEqual(await runOpsJobs(sunday), { excelTasks: 0, dataTasks: 0 });
});
