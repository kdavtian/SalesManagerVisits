// Stock count (Գույքագրում, server/src/orders/stockCount.js + routes/stockCount.js), owner 2026-10-30: every active product once a month,
// spread over the working days; a product not counted moves to the next day and that day is "not finished"; a difference against the
// Excel stock becomes one task for the accountant and a notice to the CEO / admin; the warehouse manager counts blind.
// Isolated (test/isolated-tests.txt): the plan covers EVERY active product, so other tests' products must not appear mid-way.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackProduct, trackOrder } from "./helpers.js";
import fs from "node:fs";
import { pool } from "../../src/db/pool.js";
import { spreadOverDays, workingDaysOfMonth, ensurePlan, dayList, saveCount, clearCount, closeDay, closeOpenDays, monthReport } from "../../src/orders/stockCount.js";

const MONTH = "2030-04-01"; // a future month nobody else plans: Monday the 1st
let users;
let cookies;
let products;
let wasActive;

test.before(async () => {
  await startTestServer();
  await pool.query("DELETE FROM stock_count_days");
  await pool.query("DELETE FROM stock_counts");
  // only this test's products are active while it runs
  ({ rows: wasActive } = await pool.query("SELECT id FROM products WHERE active"));
  await pool.query("UPDATE products SET active = false WHERE active");
  users = {};
  cookies = {};
  for (const role of ["admin", "ceo", "accountant", "warehouse_manager", "sales_manager"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  const days = await workingDaysOfMonth(pool, MONTH);
  const { rows } = await pool.query(
    `INSERT INTO products (name, brand, unit, unit_price_amd, active, stock_qty)
     SELECT 'ITEST stock ' || lpad(g::text, 3, '0'), 'ITEST', '4 L', 1000, true, 10 + g FROM generate_series(1, $1::int) g RETURNING id, name, stock_qty`,
    [days.length * 2]
  );
  for (const r of rows) trackProduct(r.id);
  products = rows;
});

test.after(async () => {
  await pool.query("DELETE FROM stock_count_days");
  await pool.query("DELETE FROM stock_counts");
  await pool.query("UPDATE products SET active = true WHERE id = ANY($1)", [wasActive.map((r) => r.id)]);
  await cleanupAll();
  await stopTestServer();
});

test("spreadOverDays: the same share every day, in the given order", () => {
  const plan = spreadOverDays([1, 2, 3, 4, 5, 6, 7], ["d1", "d2", "d3"]);
  assert.deepEqual(plan.map((p) => p.planned_date), ["d1", "d1", "d1", "d2", "d2", "d3", "d3"]);
});

test("working days skip Sundays (and company holidays)", async () => {
  const days = await workingDaysOfMonth(pool, MONTH);
  assert.ok(days.length >= 24 && days.length <= 26, String(days.length));
  assert.ok(!days.includes("2030-04-07"), "Sunday 7 April is not a working day");
  assert.equal(days[0], "2030-04-01");
});

test("the month's plan: every active product once, two per working day, blind list for the counter", async () => {
  const added = await ensurePlan(pool, MONTH, { force: true });
  assert.equal(added, products.length);
  assert.equal(await ensurePlan(pool, MONTH, { force: true }), 0, "a second run adds nothing");
  const blind = await dayList(pool, MONTH, { showExpected: false });
  assert.equal(blind.items.length, 2);
  assert.ok(blind.items.every((i) => !("expected_qty" in i)), "the counter does not see the Excel number");
  const open = await dayList(pool, MONTH, { showExpected: true });
  assert.equal(open.items[0].expected_qty, products.find((p) => p.id === open.items[0].product_id).stock_qty);
});

test("day 1: one counted right, one left -> not finished, carried to day 2; no task without a difference", async () => {
  const { items } = await dayList(pool, MONTH, { showExpected: true });
  const [a, b] = items;
  const ok = await saveCount(pool, users.warehouse_manager, { productId: a.product_id, qty: a.expected_qty }, MONTH);
  assert.equal(ok.item.counted_qty, a.expected_qty);
  assert.equal((await saveCount(pool, users.warehouse_manager, { productId: a.product_id, qty: -1 }, MONTH)).status, 400);
  const r = await closeDay(pool, MONTH, users.warehouse_manager.id);
  assert.equal(r.day.left_over, 1);
  assert.equal(r.day.differences, 0);
  assert.equal(r.task_id, null);
  assert.equal((await saveCount(pool, users.warehouse_manager, { productId: b.product_id, qty: 1 }, MONTH)).status, 409, "a finished day takes no more counts");
  assert.ok((await closeDay(pool, MONTH, users.warehouse_manager.id)).already);

  const day2 = await dayList(pool, "2030-04-02", { showExpected: false });
  assert.equal(day2.items.length, 3);
  assert.equal(day2.items[0].product_id, b.product_id, "the carried product comes first");
  assert.equal(day2.items[0].carried, true);
});

test("day 2: a difference -> one accountant task with a line per product, a notice to the CEO and admin; a count can be taken back", async () => {
  const day = "2030-04-02";
  const { items } = await dayList(pool, day, { showExpected: true });
  const [carried, own1] = items;
  await saveCount(pool, users.warehouse_manager, { productId: carried.product_id, qty: carried.expected_qty - 3, note: "box damaged" }, day);
  await saveCount(pool, users.warehouse_manager, { productId: own1.product_id, qty: 999 }, day);
  assert.ok((await clearCount(pool, own1.product_id, day)).ok);
  await saveCount(pool, users.warehouse_manager, { productId: own1.product_id, qty: own1.expected_qty }, day);
  const r = await closeDay(pool, day, users.warehouse_manager.id);
  assert.equal(r.differences, 1);
  assert.equal(r.day.left_over, 1);
  const { rows: [task] } = await pool.query("SELECT assignee_id, creator_id, title, to_char(due_date, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [r.task_id]);
  assert.equal(task.assignee_id, users.accountant.id);
  assert.equal(task.creator_id, users.warehouse_manager.id);
  assert.equal(task.due, "2030-04-03");
  const { rows: lines } = await pool.query("SELECT text FROM task_items WHERE task_id = $1", [r.task_id]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /\(-3\)/);
  assert.match(lines[0].text, /box damaged/);
  await new Promise((resolve) => setTimeout(resolve, 200)); // notices go out after the commit
  const { rows: notes } = await pool.query("SELECT user_id FROM notifications WHERE type = 'stock_count_diff' AND user_id = ANY($1)", [[users.admin.id, users.ceo.id]]);
  assert.equal(new Set(notes.map((n) => n.user_id)).size, 2);
});

test("a product that turns up mid-month goes to the lightest remaining day", async () => {
  const { rows: [p] } = await pool.query("INSERT INTO products (name, brand, unit, unit_price_amd, active, stock_qty) VALUES ('ITEST stock late', 'ITEST', '1 L', 1, true, 5) RETURNING id");
  trackProduct(p.id);
  // make the 5th the lightest day by moving one of its two products to the 6th
  await pool.query("UPDATE stock_counts SET planned_date = '2030-04-06' WHERE id = (SELECT id FROM stock_counts WHERE planned_date = '2030-04-05' LIMIT 1)");
  assert.equal(await ensurePlan(pool, "2030-04-03", { force: true }), 1);
  const { rows: [row] } = await pool.query("SELECT to_char(planned_date, 'YYYY-MM-DD') AS day FROM stock_counts WHERE product_id = $1", [p.id]);
  assert.equal(row.day, "2030-04-05");
});

test("the evening job closes the days left open; the month report lists days and differences", async () => {
  const r = await closeOpenDays(new Date("2030-04-04T17:00:00Z"), pool); // 21:00 in Yerevan
  assert.ok(r.closed >= 2, JSON.stringify(r));
  const { rows: auto } = await pool.query("SELECT finished_by FROM stock_count_days WHERE day = '2030-04-03'");
  assert.equal(auto[0].finished_by, null);
  const m = await monthReport(pool, MONTH, "2030-04-04");
  assert.equal(m.days[0].state, "not_finished");
  assert.equal(m.differences.length, 1);
  assert.equal(m.differences[0].difference, -3);
  assert.equal(m.totals.total, products.length + 1);
  assert.equal(m.days.find((d) => d.day === "2030-04-05").state, "future");
});

test("API: who may see and count; the counter gets no Excel number back", async () => {
  assert.equal((await apiRequest("/api/stock-count/day", { cookie: cookies.sales_manager })).status, 403);
  const acc = await apiRequest("/api/stock-count/day", { cookie: cookies.accountant });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.can_count, false);
  const wm = await apiRequest("/api/stock-count/day", { cookie: cookies.warehouse_manager });
  assert.equal(wm.status, 200);
  assert.ok(wm.data.items.every((i) => !("expected_qty" in i)));
  const item = wm.data.items.find((i) => !i.counted);
  if (item) {
    assert.equal((await apiRequest(`/api/stock-count/items/${item.product_id}`, { method: "PUT", cookie: cookies.accountant, body: { qty: 1 } })).status, 403);
    const saved = await apiRequest(`/api/stock-count/items/${item.product_id}`, { method: "PUT", cookie: cookies.warehouse_manager, body: { qty: 2 } });
    assert.equal(saved.status, 200);
    assert.deepEqual(Object.keys(saved.data).sort(), ["counted_qty", "product_id"]);
    assert.equal((await apiRequest(`/api/stock-count/items/${item.product_id}`, { method: "PUT", cookie: cookies.warehouse_manager, body: { qty: "2" } })).status, 400);
  }
  const month = await apiRequest("/api/stock-count/month", { cookie: cookies.ceo });
  assert.equal(month.status, 200);
  assert.ok(Array.isArray(month.data.days));
  const home = await apiRequest("/api/warehouse/home", { cookie: cookies.warehouse_manager });
  assert.equal(home.status, 200);
  assert.ok(home.data.stock_count && typeof home.data.stock_count.due === "number");
});

test("migration 173: the Stock count tile is added to customized lists of its roles, empty lists and other roles stay as they are, twice is safe", async () => {
  const sql = fs.readFileSync(new URL("../../migrations/173_stock_count_home_tile.sql", import.meta.url), "utf8");
  const { rows: [before] } = await pool.query("SELECT quick_action_visibility AS v FROM app_settings WHERE id = 1");
  try {
    await pool.query(
      `INSERT INTO app_settings (id, quick_action_visibility) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET quick_action_visibility = EXCLUDED.quick_action_visibility`,
      [JSON.stringify({ admin: ["qa_tasks"], ceo: ["qa_tasks", "qa_stock_count"], accountant: [], sales_manager: ["qa_tasks"] })]
    );
    await pool.query(sql);
    await pool.query(sql);
    const { rows: [after] } = await pool.query("SELECT quick_action_visibility AS v FROM app_settings WHERE id = 1");
    assert.deepEqual(after.v, { admin: ["qa_tasks", "qa_stock_count"], ceo: ["qa_tasks", "qa_stock_count"], accountant: [], sales_manager: ["qa_tasks"] });
  } finally {
    await pool.query("UPDATE app_settings SET quick_action_visibility = $1::jsonb WHERE id = 1", [before?.v == null ? null : JSON.stringify(before.v)]);
  }
});

// Owner, 2026-11-03: the warehouse manager SIGNS the day (mandatory), may add a photo, the day's report is a PDF, Vaghinak gives him a task to
// recheck what differs and tells the accountants the result.
test("finishing the day needs the drawn signature; with it the day is signed, its PDF exists, the counter gets a recheck task and the accountant a notice", async () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const day = (await apiRequest("/api/stock-count/day", { cookie: cookies.admin })).data;
  const first = day.items.slice(0, 2);
  assert.ok(first.length === 2, "today has products to count");
  for (const it of first) {
    const r = await apiRequest(`/api/stock-count/items/${it.product_id}`, { method: "PUT", cookie: cookies.warehouse_manager, body: { qty: Number(it.expected_qty ?? 0) + 5 } });
    assert.equal(r.status, 200);
  }
  const { apiFormRequest } = await import("./helpers.js");
  // without a signature: refused, nothing closed
  const none = new FormData();
  const refused = await apiFormRequest("/api/stock-count/finish", { form: none, cookie: cookies.warehouse_manager });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, "signature_required");
  assert.equal((await pool.query("SELECT 1 FROM stock_count_days WHERE day = $1", [day.day])).rowCount, 0);
  // a signature + a photo of the paper count
  const form = new FormData();
  form.set("signature", new Blob([PNG], { type: "image/png" }), "sig.png");
  form.set("attachment", new Blob([PNG], { type: "image/png" }), "paper.png");
  const ok = await apiFormRequest("/api/stock-count/finish", { form, cookie: cookies.warehouse_manager });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const { rows: [closed] } = await pool.query("SELECT signature_path, signed_at, attachment_path, pdf_path, finished_by, differences FROM stock_count_days WHERE day = $1", [day.day]);
  assert.ok(closed.signature_path && closed.signed_at && closed.attachment_path, "signature and photo are kept");
  assert.ok(closed.pdf_path, "the PDF report is saved");
  assert.equal(closed.finished_by, users.warehouse_manager.id);
  assert.ok(closed.differences >= 2);
  // the report opens for the counter and for the accountant, not for a rep
  for (const who of ["warehouse_manager", "accountant"]) {
    const r = await apiRequest(`/api/stock-count/day/${day.day}/pdf`, { cookie: cookies[who] });
    assert.equal(r.status, 200, who);
  }
  const viaApi = await apiRequest(`/api/stock-count/day/${day.day}/pdf`, { cookie: cookies.accountant });
  assert.equal(viaApi.status, 200);
  assert.ok(String(viaApi.data).startsWith("%PDF"));
  assert.equal((await apiRequest(`/api/stock-count/day/${day.day}/pdf`, { cookie: cookies.sales_manager })).status, 403);
  // Vaghinak: a recheck task for the counter (one line per product that differs), the accountant's own task, a list in Documents
  const { rows: tasks } = await pool.query("SELECT id, assignee_id, title FROM tasks WHERE title LIKE $1 AND assignee_id = ANY($2)", [`%Գույքագրում ${day.day.slice(8, 10)}.${day.day.slice(5, 7)}%`, [users.warehouse_manager.id, users.accountant.id]]);
  const recheck = tasks.find((t) => t.assignee_id === users.warehouse_manager.id);
  assert.ok(recheck, "the counter has a task to recheck");
  assert.equal((await pool.query("SELECT 1 FROM task_items WHERE task_id = $1", [recheck.id])).rowCount, closed.differences);
  assert.ok(tasks.some((t) => t.assignee_id === users.accountant.id), "the accountant has the differences as a task");
  const docs = await apiRequest("/api/stock-count/documents", { cookie: cookies.accountant });
  assert.ok(docs.data.some((d) => d.day === day.day && d.signed === true && d.has_attachment === true));
});

// Owner, 2026-11-04: the count is compared with the stock the APP knows (appStock.js), not the Excel number -- sales not in Excel yet are
// already off the shelf. Excel 50: packed 7, delivered 4 (not found in Excel yet) and delivered 6 BEFORE the last sync but still not in
// Excel are subtracted; a good return received and not in Excel yet (2) is added back. Unchanged: a confirmed order (still on the shelf),
// a delivery Excel already holds (matched), one the ERP sync itself delivered, an unmatched delivery older than the matching window, a
// damaged return, and a return already recorded in Excel. 50 - 7 - 4 - 6 + 2 = 35.
test("the counted quantity is compared with the app's stock, not the Excel number", async () => {
  const day = "2030-04-22";
  const { rows: [p] } = await pool.query(
    "INSERT INTO products (name, brand, unit, unit_price_amd, active, stock_qty, synced_at) VALUES ('ITEST stock app', 'ITEST', '4 L', 1000, true, 50, now() - interval '1 hour') RETURNING id"
  );
  trackProduct(p.id);
  await pool.query("INSERT INTO stock_counts (month, product_id, planned_date) VALUES ($1, $2, $3)", [MONTH, p.id, day]);
  const customer = await createCustomer({ created_by: users.admin.id });
  let n = 0;
  const order = async (status, qty, { deliveredAgo = null, inExcel = false, fromErp = false } = {}) => {
    const { rows: [o] } = await pool.query(
      "INSERT INTO orders (customer_id, user_id, status, total_amd, delivered_from_erp, erp_matched_order_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [customer.id, users.admin.id, status, qty * 1000, fromErp, inExcel || fromErp ? `ITEST-SC-${p.id}-${++n}` : null]
    );
    trackOrder(o.id);
    await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'ITEST stock app', 1000, $3, $4)", [o.id, p.id, qty, qty * 1000]);
    if (deliveredAgo) await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'packed_stock_out', 'delivered', now() - $2::interval)", [o.id, deliveredAgo]);
    return o.id;
  };
  await order("packed_stock_out", 7);
  await order("delivered", 4, { deliveredAgo: "10 minutes" });
  await order("delivered", 6, { deliveredAgo: "3 hours" });
  await order("confirmed", 5);
  await order("delivered", 8, { deliveredAgo: "10 minutes", inExcel: true });
  await order("delivered", 9, { deliveredAgo: "10 minutes", fromErp: true });
  await order("delivered", 11, { deliveredAgo: "20 days" });
  const returned = await order("delivered", 6, { deliveredAgo: "5 days", inExcel: true });
  const ret = async (qty, condition, recorded) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO order_returns (order_id, customer_id, kind, status, reason, order_status_at_request, received_at, recorded_at, recorded_via)
       VALUES ($1, $2, 'return', 'done', 'other', 'delivered', now(), $3, $4) RETURNING id`,
      [returned, customer.id, recorded ? new Date(Date.now() - 2 * 3600 * 1000) : null, recorded ? "erp" : null]
    );
    await pool.query("INSERT INTO order_return_items (return_id, product_id, product_name, quantity, condition) VALUES ($1, $2, 'ITEST stock app', $3, $4)", [r.id, p.id, qty, condition]);
  };
  await ret(2, "good", false);
  await ret(1, "damaged", false);
  await ret(3, "good", true);

  const shown = (await dayList(pool, day, { showExpected: true })).items.find((i) => i.product_id === p.id);
  assert.equal(shown?.expected_qty, 35, "management sees the app's stock before the count");
  const saved = await saveCount(pool, users.warehouse_manager, { productId: p.id, qty: 35 }, day);
  assert.equal(saved.item.expected_qty, 35);
  assert.equal(saved.item.counted_qty - saved.item.expected_qty, 0, "no difference: the shelf matches the app");
  await clearCount(pool, p.id, day);
});
