// Process-logic fixes: credit limit approval, far check-ins
// counting as visits, a failed delivery staying "packed", the manual
// order <-> Excel link, and stock available after other orders' reservations.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;
const erpIds = [];
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_director", "sales_manager", "accountant", "delivery_manager", "ceo", "operations_director"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

async function erpCustomer(suffix, debt = 0) {
  const erpId = `ITEST-PR-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', $2, now())", [erpId, debt]);
  return customer;
}
async function order(customer, product, quantity) {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity }], payment_method: "invoice" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  return res.data;
}

test("credit limit: an over-limit order needs a director's approval before it can be confirmed", async () => {
  const customer = await erpCustomer("credit", 100000);
  const product = await createProduct({ unit_price_amd: 1000 });
  // Only the accountant / directors set credit terms.
  const denied = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.sales_manager, body: { credit_limit_amd: 150000 } });
  assert.equal(denied.status, 403);
  const set = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.accountant, body: { credit_limit_amd: 150000 } });
  assert.equal(set.status, 200);
  assert.equal(set.data.credit_limit_amd, 150000);

  const small = await order(customer, product, 10); // 100k debt + 10k = 110k <= 150k
  assert.equal(small.credit_status, "not_required");

  const big = await order(customer, product, 100); // 100k + 10k open + 100k = 210k > 150k
  assert.equal(big.credit_status, "pending");

  const blocked = await apiRequest(`/api/orders/${big.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /credit limit/i);

  // A sales rep cannot approve; the accountant can.
  assert.equal((await apiRequest(`/api/orders/${big.id}/approve-credit`, { method: "POST", cookie: cookies.sales_manager })).status, 403);
  const approved = await apiRequest(`/api/orders/${big.id}/approve-credit`, { method: "POST", cookie: cookies.accountant });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.credit_status, "approved");
  const confirmed = await apiRequest(`/api/orders/${big.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));

  // No limit = no check.
  await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.accountant, body: { credit_limit_amd: null } });
  const free = await order(customer, product, 500);
  assert.equal(free.credit_status, "not_required");
});

test("a rep's check-in counts as a visit at any distance; a director's never does", async () => {
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id });
  const insert = (userId, withinRange) =>
    pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp) VALUES ($1, $2, 40.18, 44.51, $3, $4, now()) RETURNING id`,
      [customer.id, userId, withinRange ? 5 : 5000, withinRange]
    );
  await insert(users.sales_director.id, true);
  const before = await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.sales_manager });
  assert.equal(before.data.last_visit_at, null);
  assert.equal(before.data.visited_today, false);
  await insert(users.sales_manager.id, false); // saved before the check-in allowance existed / pin was wrong
  const after = await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.sales_manager });
  assert.ok(after.data.last_visit_at);
  assert.equal(after.data.visited_today, true);
});

test("a failed delivery leaves the order packed (not draft)", async () => {
  const customer = await erpCustomer("fail");
  const product = await createProduct();
  const o = await order(customer, product, 1);
  await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [o.id]);
  const res = await apiRequest(`/api/delivery/orders/${o.id}/fail`, { method: "POST", cookie: cookies.delivery_manager });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "packed_stock_out");
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [o.id]);
  assert.equal(rows[0].status, "packed_stock_out");
});

test("manual link: an unmatched confirmed order can be linked to a free Excel order once", async () => {
  const customer = await erpCustomer("link");
  const product = await createProduct({ unit_price_amd: 1000 });
  const o = await order(customer, product, 5); // 5000
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o.id]);
  const excelId = `ITEST-EXCEL-${stamp}`;
  // The accountant changed the total in Excel, so the automatic match would not find it.
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 4500)", [customer.erp_customer_id, excelId]);

  assert.equal((await apiRequest(`/api/orders/${o.id}/erp-candidates`, { cookie: cookies.sales_manager })).status, 403);
  const cands = await apiRequest(`/api/orders/${o.id}/erp-candidates`, { cookie: cookies.accountant });
  assert.equal(cands.status, 200);
  assert.ok(cands.data.some((c) => c.erp_order_id === excelId && c.diff_amd === 500));

  assert.equal((await apiRequest(`/api/orders/${o.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: "nope" } })).status, 409);
  const linked = await apiRequest(`/api/orders/${o.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: excelId } });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.status, "recorded", "linked to the Excel: delivered and recorded at once (the Excel proves it)");
  assert.equal(linked.data.delivered_from_erp, true);
  assert.equal(linked.data.recorded_by, null, "the Excel proves it: no person is credited with recording it");
  assert.equal(linked.data.erp_matched_order_id, excelId);
  // The same Excel order cannot be linked twice.
  const o2 = await order(customer, product, 5);
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o2.id]);
  assert.equal((await apiRequest(`/api/orders/${o2.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: excelId } })).status, 409);
});

test("products show stock still available after other orders' reservations", async () => {
  const customer = await erpCustomer("stock");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 10 WHERE id = $1", [product.id]);
  const o = await order(customer, product, 4);
  const view = async () => (await apiRequest("/api/products", { cookie: cookies.sales_manager })).data.find((x) => x.id === product.id);
  // owner, 2026-11-11: a submitted order does not hold stock; it is only counted as "wanted" for the rep's warning
  let p = await view();
  assert.equal(p.reserved_qty, 0);
  assert.equal(p.submitted_qty, 4);
  assert.equal(p.available_qty, 10);
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o.id]);
  p = await view();
  assert.equal(p.reserved_qty, 4, "confirmed: it holds now");
  assert.equal(p.available_qty, 6);
});

// Owner, 2026-11-11: "Castrol Dexron VI 1L shows 0 on stock but we have it; I can't find the 17 pcs in other orders". A delivered order the Excel
// ALREADY holds was subtracted a second time whenever it changed after the product's last stock sync (and synced_at only moves when the Excel
// quantity changes). Delivered-but-not-in-Excel uses the stock count's rule now: no Excel match, delivered in the last 14 days.
test("a delivered order the Excel already shows no longer holds stock; one the Excel does not show yet still does; the holding orders are listed", async () => {
  const customer = await erpCustomer("hold");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 17, synced_at = now() - interval '5 days' WHERE id = $1", [product.id]);
  // the Excel is up to date (its newest order is today): the 14-day window runs on the Excel's clock
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 1)", [customer.erp_customer_id, `ITEST-HOLD-TODAY-${stamp}`]);
  const inExcel = await order(customer, product, 17);
  // the sync found it in the workbook and moved it to delivered; later something else touched it (updated_at after synced_at)
  await pool.query("UPDATE orders SET status = 'delivered', delivered_from_erp = true, erp_matched_order_id = $2, updated_at = now() WHERE id = $1", [inExcel.id, `ITEST-HOLD-${stamp}`]);
  const view = async () => (await apiRequest("/api/products", { cookie: cookies.sales_manager })).data.find((x) => x.id === product.id);
  let p = await view();
  assert.equal(p.reserved_qty, 0, "the Excel stock already left those 17 out: they are not subtracted again");
  assert.equal(p.available_qty, 17);
  // the out-of-stock guard agrees: a new order for it is accepted
  const ok = await order(customer, product, 3);
  p = await view();
  assert.equal(p.reserved_qty, 0, "a submitted order does not hold");
  assert.equal(p.submitted_qty, 3);
  // delivered in the app, not in the Excel yet: still held
  await pool.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1", [ok.id]);
  assert.equal((await view()).reserved_qty, 3);
  const holding = await apiRequest(`/api/products/${product.id}/holding-orders`, { cookie: cookies.sales_manager });
  assert.equal(holding.status, 200);
  assert.deepEqual(holding.data.map((r) => [r.status, r.quantity]), [["delivered", 3]]);
  assert.equal(holding.data[0].order_code, ok.order_code, "the rep sees their own order");
  // more than 14 days after delivery an unmatched order is taken as already in the Excel stock (the stock count's rule)
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'confirmed', 'delivered', now() - interval '20 days')", [ok.id]);
  await pool.query("UPDATE orders SET updated_at = now() - interval '20 days' WHERE id = $1", [ok.id]);
  assert.equal((await view()).reserved_qty, 0);
});

test("confirming takes the pieces: a submitted order that no longer fits the stock cannot be confirmed; the credit check counts a delivered order the Excel holds once", async () => {
  const customer = await erpCustomer("short");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 5 WHERE id = $1", [product.id]);
  const first = await order(customer, product, 4);
  const second = await order(customer, product, 3); // both submitted: 7 wanted, 5 on the shelf -- allowed, the rep was warned
  const confirm = (id) => apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  const c1 = await confirm(first.id);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  const c2 = await confirm(second.id);
  assert.equal(c2.status, 409);
  assert.equal(c2.data.code, "short_stock");
  assert.deepEqual(c2.data.products.map((p) => [p.wanted, p.available]), [[3, 1]]);

  // credit: a delivered order the Excel already holds is not counted again in the exposure
  const { evaluateCredit } = await import("../../src/orders/creditLimit.js");
  await pool.query("UPDATE orders SET status = 'delivered', delivered_from_erp = true, erp_matched_order_id = $2, updated_at = now() WHERE id = $1", [first.id, `ITEST-CR-${stamp}`]);
  await pool.query("UPDATE erp_customer_data SET synced_at = now() - interval '1 day' WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  const snap = await evaluateCredit(pool, customer.id, 0);
  assert.equal(snap.openOrders, Number(second.total_amd), "only the submitted order: the delivered one is already in the Excel debt");
});

test("an edit sent together with the confirmation is checked with its new quantities; a correction of a confirmed order cannot add pieces the shelf does not have", async () => {
  const customer = await erpCustomer("short2");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 5 WHERE id = $1", [product.id]);
  const o = await order(customer, product, 2);
  const both = await apiRequest(`/api/orders/${o.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { items: [{ product_id: product.id, quantity: 50 }], status: "confirmed" } });
  assert.equal(both.status, 409, JSON.stringify(both.data));
  assert.equal(both.data.code, "short_stock");
  const ok = await apiRequest(`/api/orders/${o.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const correct = (quantity) => apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: cookies.accountant, body: { reason: "customer asked", items: [{ product_id: product.id, quantity }] } });
  const tooMany = await correct(20);
  assert.equal(tooMany.status, 409, JSON.stringify(tooMany.data));
  assert.equal(tooMany.data.code, "short_stock");
  const fewer = await correct(1);
  assert.equal(fewer.status, 200, JSON.stringify(fewer.data));
});

// Owner, 2026-11-11: delivered, still not in the Excel 14 days later -> "Not in Excel" flag, the order STAYS delivered, the accountant gets a list.
test("a delivery the Excel still does not show after 14 days is flagged and listed for the accountant; the flag clears when it is recorded", async () => {
  const { flagOrdersNotInExcel } = await import("../../src/orders/notInExcel.js");
  const customer = await erpCustomer("nie");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 50 WHERE id = $1", [product.id]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 1)", [customer.erp_customer_id, `ITEST-NIE-TODAY-${stamp}`]);
  const late = await order(customer, product, 2);
  const fresh = await order(customer, product, 1);
  await pool.query("UPDATE orders SET status = 'delivered', updated_at = now() - interval '20 days' WHERE id = $1", [late.id]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'packed_stock_out', 'delivered', now() - interval '20 days')", [late.id]);
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [fresh.id]);
  await flagOrdersNotInExcel(pool);
  const state = async (id) => (await pool.query("SELECT status, not_in_excel_at FROM orders WHERE id = $1", [id])).rows[0];
  assert.ok((await state(late.id)).not_in_excel_at, "20 days, not in Excel: flagged");
  assert.equal((await state(late.id)).status, "delivered", "it stays delivered");
  assert.equal((await state(fresh.id)).not_in_excel_at, null, "delivered today: not yet");
  const { rows: tasks } = await pool.query("SELECT t.id, (SELECT array_agg(text) FROM task_items WHERE task_id = t.id) AS items FROM tasks t WHERE t.auto_kind = 'order_not_in_excel' AND t.status = 'open' AND t.assignee_id = $1", [users.accountant.id]);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].items.some((i) => i.includes(late.order_code)));
  // the accountant marks it recorded: the flag goes at once, and the list closes on the next run
  const rec = await apiRequest(`/api/orders/${late.id}/recorded`, { method: "PATCH", cookie: cookies.accountant, body: { recorded: true } });
  assert.ok([200, 201].includes(rec.status), JSON.stringify(rec.data));
  assert.equal((await state(late.id)).not_in_excel_at, null);
  await flagOrdersNotInExcel(pool);
  const { rows: still } = await pool.query(
    "SELECT (SELECT array_agg(text) FROM task_items WHERE task_id = t.id) AS items FROM tasks t WHERE t.auto_kind = 'order_not_in_excel' AND t.status = 'open' AND t.assignee_id = $1",
    [users.accountant.id]
  );
  assert.ok(!still.some((t) => (t.items ?? []).some((i) => i.includes(late.order_code))), "the recorded order left the accountant's list (the task closes when the list is empty)");
});

test("the accountant's list: ticking every line does not close it (it closes when the list is empty), and a run without changes keeps the ticks", async () => {
  const { flagOrdersNotInExcel } = await import("../../src/orders/notInExcel.js");
  const customer = await erpCustomer("nie2");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 50 WHERE id = $1", [product.id]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 1)", [customer.erp_customer_id, `ITEST-NIE2-TODAY-${stamp}`]);
  const late = await order(customer, product, 2);
  await pool.query("UPDATE orders SET status = 'delivered', updated_at = now() - interval '20 days' WHERE id = $1", [late.id]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'packed_stock_out', 'delivered', now() - interval '20 days')", [late.id]);
  await flagOrdersNotInExcel(pool);
  const { rows: [task] } = await pool.query("SELECT id FROM tasks WHERE auto_kind = 'order_not_in_excel' AND status = 'open' AND assignee_id = $1", [users.accountant.id]);
  const { rows: items } = await pool.query("SELECT id FROM task_items WHERE task_id = $1", [task.id]);
  for (const it of items) {
    const r = await apiRequest(`/api/tasks/${task.id}/items/${it.id}`, { method: "POST", cookie: cookies.accountant, body: { done: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal((await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id])).rows[0].status, "open", "ticking does not close the list");
  await flagOrdersNotInExcel(pool); // nothing changed
  const { rows: after } = await pool.query("SELECT bool_and(done) AS all_done FROM task_items WHERE task_id = $1", [task.id]);
  assert.equal(after[0].all_done, true, "the ticks survive a run");
  await pool.query("UPDATE orders SET recorded = true WHERE id = $1", [late.id]);
});

// Owner, 2026-11-11: "Recorded" is the final status after delivered -- given by the accountant, the CEO or the admin, or by the sync when the Excel
// shows the order. A recorded order counts exactly like a delivered one (stock it holds until the Excel shows it, live debt, returns).
test("Recorded: the accountant / CEO / admin record a delivered order; it still counts as delivered; undo keeps the delivery date", async () => {
  const { liveAdjustments } = await import("../../src/money/liveDebt.js");
  const customer = await erpCustomer("rec");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 20 WHERE id = $1", [product.id]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 1)", [customer.erp_customer_id, `ITEST-REC-TODAY-${stamp}`]);
  const o = await order(customer, product, 4);
  await pool.query("UPDATE orders SET status = 'delivered', updated_at = now() - interval '3 days' WHERE id = $1", [o.id]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'packed_stock_out', 'delivered', now() - interval '3 days')", [o.id]);
  const record = (cookie, recorded = true) => apiRequest(`/api/orders/${o.id}/recorded`, { method: "PATCH", cookie, body: { recorded } });

  // who may: accountant, CEO, admin -- not the rep, not the operations director (they see the backlog only)
  assert.equal((await record(cookies.sales_manager)).status, 403);
  assert.equal((await record(cookies.operations_director)).status, 403);
  // a submitted order cannot be recorded
  const notYet = await order(customer, product, 1);
  const early = await apiRequest(`/api/orders/${notYet.id}/recorded`, { method: "PATCH", cookie: cookies.ceo, body: { recorded: true } });
  assert.equal(early.status, 409);

  const debtBefore = (await liveAdjustments(pool, [customer.id])).get(customer.id);
  const r1 = await record(cookies.ceo);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.status, "recorded");
  assert.equal(r1.data.recorded, true, "the old tick follows the status (old phones)");
  // a double tap / retry changes nothing and writes no second timeline row
  const r2 = await record(cookies.accountant);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.recorded_by, users.ceo.id, "the first one recorded it");
  const { rows: hist } = await pool.query("SELECT old_status, new_status, changed_by FROM order_status_history WHERE order_id = $1 AND new_status = 'recorded'", [o.id]);
  assert.deepEqual(hist, [{ old_status: "delivered", new_status: "recorded", changed_by: users.ceo.id }]);

  // still counted as delivered: holds its pieces until the Excel shows it, still in the live debt with the same delivery date
  const view = async () => (await apiRequest("/api/products", { cookie: cookies.sales_manager })).data.find((x) => x.id === product.id);
  assert.equal((await view()).reserved_qty, 4);
  const debtAfter = (await liveAdjustments(pool, [customer.id])).get(customer.id);
  assert.deepEqual(debtAfter.orders, debtBefore.orders);
  // it shows on the Recorded tab, not on the backlog
  const tab = async (recorded) => (await apiRequest(`/api/orders/recorded-list?recorded=${recorded}`, { cookie: cookies.accountant })).data.rows.map((r) => r.id);
  assert.ok((await tab(true)).includes(o.id));
  assert.ok(!(await tab(false)).includes(o.id));
  // a return is still possible (a recorded order was delivered)
  const ret = await apiRequest(`/api/returns/order/${o.id}/returnable`, { cookie: cookies.sales_manager });
  assert.equal(ret.status, 200, JSON.stringify(ret.data));
  assert.equal(ret.data.kind, "return");

  // undo: back to delivered, and the delivery date does NOT move to the undo time
  const undo = await record(cookies.admin, false);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(undo.data.status, "delivered");
  assert.equal(undo.data.recorded, false);
  assert.deepEqual((await liveAdjustments(pool, [customer.id])).get(customer.id).orders, debtBefore.orders);
});

test("Recorded: the sync records by itself a delivered order it finds in the Excel; KAD OS and Lily still see it as delivered", async () => {
  const { markAppRowsInExcel } = await import("../../src/erp/erpAutoMatch.js");
  const { partnerStatus } = await import("../../src/orders/appOrders.js");
  const customer = await erpCustomer("recx");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 20 WHERE id = $1", [product.id]);
  const o = await order(customer, product, 3); // 3000
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [o.id]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status) VALUES ($1, 'packed_stock_out', 'delivered')", [o.id]);
  const excelId = `ITEST-RECX-${stamp}`;
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 3000)", [customer.erp_customer_id, excelId]);
  await markAppRowsInExcel(pool);
  const { rows } = await pool.query("SELECT status, recorded, recorded_by, erp_matched_order_id FROM orders WHERE id = $1", [o.id]);
  assert.deepEqual(rows[0], { status: "recorded", recorded: true, recorded_by: null, erp_matched_order_id: excelId });
  const list = await apiRequest("/api/orders/recorded-list?recorded=true", { cookie: cookies.accountant });
  const row = list.data.rows.find((r) => r.id === o.id);
  assert.ok(row && row.recorded_by_name == null, "shown as found in the Excel (no person)");
  assert.equal(partnerStatus("recorded", false), "delivered");
  // the orders list filters by the new status
  const filtered = await apiRequest("/api/orders?status=recorded", { cookie: cookies.accountant });
  assert.equal(filtered.status, 200);
  const items = filtered.data.rows ?? filtered.data.orders ?? filtered.data;
  assert.ok(Array.isArray(items) && items.some((x) => x.id === o.id));
});
