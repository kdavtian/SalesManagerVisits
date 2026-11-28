// Improvement plan "Phase 0: stop losses" (2026-11-28), items 0.10-0.14: what each role may read or do through the API, per route, so a
// screen that merely hides a button can never again be the only lock.
//   0.10 the company sales plan: management only (seesAllPerformance)
//   0.11 an order's signed documents: a rep opens only his customers' papers
//   0.12 "a rep reaches only his own customers" (+ the offices) on check-in, delivery list, social profiles, shelf status
//   0.13 payments, hand-overs, shortfalls: the money roles see all; a rep, a driver, the warehouse only their own
//   0.14 supplier cost fields never reach a role that may not see costs (an allow-list)
import test from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  cleanupAll,
  createUser,
  createCustomer,
  createProduct,
  loginAs,
  apiRequest,
  apiFormRequest,
  trackOrder,
  trackCheckin,
  trackPayment,
  trackHandoff,
} from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { PRODUCT_FIELDS_FOR_ALL, PRODUCT_COST_FIELDS } from "../../src/products/routes/products.js";

const MANAGEMENT = ["admin", "ceo", "operations_director", "sales_director", "accountant"];
const OTHERS = ["sales_manager", "warehouse_manager", "delivery_manager"];
const users = {};
const cookies = {};
let repB;
let repBCookie;
let customerA; // rep A's (users.sales_manager)
let customerB; // rep B's
let office; // checkin_for_all
let planId;
let planMonth;
const docs = {};

test.before(async () => {
  await startTestServer();
  for (const role of [...MANAGEMENT, ...OTHERS]) {
    users[role] = await createUser(role, { name: `P0 ${role}` });
    cookies[role] = await loginAs(users[role].email);
  }
  repB = await createUser("sales_manager", { name: "P0 rep B" });
  repBCookie = await loginAs(repB.email);
  customerA = await createCustomer({ created_by: users.sales_manager.id });
  customerB = await createCustomer({ created_by: repB.id });
  office = await createCustomer({ created_by: users.admin.id, assigned_manager_id: users.admin.id });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [office.id]);

  // a plan in a month nobody else uses
  const { rows: [p] } = await pool.query(
    "INSERT INTO perf_plans (month, version, status, created_by) VALUES (make_date(2300 + (random() * 600)::int, 1 + (random() * 11)::int, 1), 1, 'draft', $1) RETURNING id, to_char(month, 'YYYY-MM-DD') AS month",
    [users.ceo.id]
  );
  planId = p.id;
  planMonth = p.month;

  // one order with one signed document per customer; the orders are placed by somebody else (the sales director, not via the app)
  for (const [key, c] of [["a", customerA], ["b", customerB]]) {
    const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd) VALUES ($1, $2, 'delivered', 1000) RETURNING id", [c.id, users.sales_director.id]);
    trackOrder(o.id);
    const pdf = Buffer.from("%PDF-1.4 test");
    docs[key] = (await pool.query("INSERT INTO order_documents (order_id, filename, size_bytes, data) VALUES ($1, 'signed.pdf', $2, $3) RETURNING id", [o.id, pdf.length, pdf])).rows[0].id;
  }
});

test.after(async () => {
  await pool.query("DELETE FROM perf_plan_comments WHERE plan_id = $1", [planId]);
  await pool.query("DELETE FROM perf_plan_audit WHERE plan_id = $1", [planId]);
  await pool.query("DELETE FROM perf_plans WHERE id = $1", [planId]);
  await pool.query("DELETE FROM cash_shortfalls WHERE user_id = ANY($1)", [[users.sales_manager.id, repB.id]]);
  await pool.query("DELETE FROM order_documents WHERE id = ANY($1)", [Object.values(docs)]);
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1) OR creator_id = ANY($1)", [[...Object.values(users).map((u) => u.id), repB.id]]);
  await cleanupAll();
  await stopTestServer();
});

// ---- 0.10 the sales plan -----------------------------------------------------------------------------------------------------------------
test("0.10: the plan, its history, audit and comments answer only the management roles", async () => {
  const routes = [
    ["GET", `/api/team-performance/plans?month=${planMonth}`],
    ["GET", `/api/team-performance/plans/${planId}`],
    ["GET", `/api/team-performance/plans/${planId}/history`],
    ["GET", `/api/team-performance/plans/${planId}/audit`],
    ["POST", `/api/team-performance/plans/${planId}/comments`],
  ];
  for (const role of [...MANAGEMENT, ...OTHERS]) {
    for (const [method, path] of routes) {
      const r = await apiRequest(path, { method, cookie: cookies[role], body: method === "POST" ? { body: `note by ${role}` } : undefined });
      const expected = MANAGEMENT.includes(role) ? (method === "POST" ? 201 : 200) : 403;
      assert.equal(r.status, expected, `${role} ${method} ${path}`);
    }
  }
  const plan = await apiRequest(`/api/team-performance/plans?month=${planMonth}`, { cookie: cookies.ceo });
  assert.equal(plan.data.id, planId);
  // a rep still has his own view
  assert.notEqual((await apiRequest(`/api/team-performance/my-performance?month=${planMonth}`, { cookie: cookies.sales_manager })).status, 500);
});

// ---- 0.11 signed documents ---------------------------------------------------------------------------------------------------------------
test("0.11: rep B gets 403 on rep A's customer's document; rep A opens it even when somebody else placed the order", async () => {
  for (const kind of ["file", "preview"]) {
    assert.equal((await apiRequest(`/api/orders/documents/${docs.a}/${kind}`, { cookie: repBCookie })).status, 403, `rep B ${kind}`);
  }
  const own = await apiRequest(`/api/orders/documents/${docs.a}/file`, { cookie: cookies.sales_manager });
  assert.equal(own.status, 200, "listed on his customer's card, so it opens");
  assert.equal((await apiRequest(`/api/orders/documents/${docs.b}/file`, { cookie: cookies.sales_manager })).status, 403);
  // management and the driver (recent order) still open it; the warehouse sees no paper with amounts (unchanged)
  for (const role of [...MANAGEMENT, "delivery_manager"]) {
    assert.equal((await apiRequest(`/api/orders/documents/${docs.a}/file`, { cookie: cookies[role] })).status, 200, role);
  }
  assert.equal((await apiRequest(`/api/orders/documents/${docs.a}/file`, { cookie: cookies.warehouse_manager })).status, 403);
  // the card's list: rep B cannot list rep A's customer's documents (the card guard answers 404)
  assert.equal((await apiRequest(`/api/customers/${customerA.id}/documents`, { cookie: repBCookie })).status, 404);
  const list = await apiRequest(`/api/customers/${customerA.id}/documents`, { cookie: cookies.sales_manager });
  assert.deepEqual(list.data.map((d) => d.id), [docs.a]);
});

// ---- 0.12 reaching a customer ------------------------------------------------------------------------------------------------------------
async function checkin(cookie, customerId) {
  const form = new FormData();
  form.set("customer_id", String(customerId));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["payment_collected"]));
  form.set("amount_collected_amd", "5000");
  form.set("client_ref", `p0-${customerId}-${Math.random()}`);
  const r = await apiFormRequest("/api/checkins", { form, cookie });
  if (r.status === 201) {
    trackCheckin(r.data.id);
    const { rows } = await pool.query("SELECT id FROM payments WHERE client_ref = $1", [`checkin-${r.data.id}`]);
    rows.forEach((p) => trackPayment(p.id));
  }
  return r;
}

test("0.12: a rep checks in (and records money) only at his own customers and the offices; 403 keeps a queued visit on the phone", async () => {
  const refused = await checkin(repBCookie, customerA.id);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, "customer_not_assigned");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM checkins WHERE customer_id = $1 AND user_id = $2", [customerA.id, repB.id])).rows[0].n, 0);
  assert.equal((await checkin(cookies.sales_manager, customerA.id)).status, 201, "own customer");
  const officeForm = new FormData();
  officeForm.set("customer_id", String(office.id));
  officeForm.set("lat", "40.18");
  officeForm.set("lng", "44.51");
  const atOffice = await apiFormRequest("/api/checkins", { form: officeForm, cookie: repBCookie });
  assert.equal(atOffice.status, 201, "the office is open to every rep");
  trackCheckin(atOffice.data.id);
  // every other role still checks in anywhere
  for (const role of [...MANAGEMENT, "warehouse_manager", "delivery_manager"]) {
    assert.equal((await checkin(cookies[role], customerB.id)).status, 201, role);
  }
});

test("0.12: the delivery list, social profiles and shelf status follow the same rule", async () => {
  assert.equal((await apiRequest(`/api/checkins/deliverable-orders?customer_id=${customerA.id}`, { cookie: repBCookie })).status, 404);
  assert.equal((await apiRequest(`/api/checkins/deliverable-orders?customer_id=${customerA.id}`, { cookie: cookies.sales_manager })).status, 200);
  assert.equal((await apiRequest(`/api/customer-social/${customerA.id}`, { cookie: repBCookie })).status, 404);
  assert.equal((await apiRequest(`/api/customer-social/${customerA.id}`, { cookie: cookies.sales_manager })).status, 200);
  assert.equal((await apiRequest(`/api/customer-social/${office.id}`, { cookie: repBCookie })).status, 200);
  for (const role of [...MANAGEMENT, "warehouse_manager", "delivery_manager"]) {
    assert.equal((await apiRequest(`/api/checkins/deliverable-orders?customer_id=${customerA.id}`, { cookie: cookies[role] })).status, 200, role);
    assert.equal((await apiRequest(`/api/customer-social/${customerA.id}`, { cookie: cookies[role] })).status, 200, role);
  }

  await pool.query("UPDATE checkins SET brand_status = '{\"castrol\":[\"available\"]}' WHERE customer_id = ANY($1)", [[customerA.id, customerB.id]]);
  const seen = async (cookie) => new Set((await apiRequest("/api/customers/brand-status", { cookie })).data.map((r) => r.customer_id));
  const repA = await seen(cookies.sales_manager);
  assert.ok(repA.has(customerA.id) && !repA.has(customerB.id), "rep A: his own only");
  const rB = await seen(repBCookie);
  assert.ok(rB.has(customerB.id) && !rB.has(customerA.id), "rep B: his own only");
  for (const role of MANAGEMENT) {
    const all = await seen(cookies[role]);
    assert.ok(all.has(customerA.id) && all.has(customerB.id), role);
  }
});

// ---- 0.13 money --------------------------------------------------------------------------------------------------------------------------
test("0.13: payments, hand-overs and shortfalls -- the money roles see all; a rep, a driver and the warehouse only their own", async () => {
  const { rows: [pay] } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
     VALUES ($1, 'x', 30000, now(), $2, 'Rep A', 'pending', $2, $2) RETURNING id`,
    [customerA.id, users.sales_manager.id]
  );
  trackPayment(pay.id);
  const h = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users.sales_director.id, payment_ids: [pay.id] } });
  assert.equal(h.status, 201, JSON.stringify(h.data));
  trackHandoff(h.data.id);
  const confirmed = await apiRequest(`/api/cash-handoffs/${h.data.id}/confirm`, { method: "POST", cookie: cookies.sales_director, body: { counted_amd: 29000, note: "short" } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const { rows: [sf] } = await pool.query("SELECT id FROM cash_shortfalls WHERE handoff_id = $1", [h.data.id]);
  assert.ok(sf, "a shortfall was opened");

  const shortfallIds = async (cookie) => {
    const r = await apiRequest("/api/cash-handoffs/shortfalls", { cookie });
    return [...r.data.open, ...r.data.closed].map((s) => s.id);
  };
  for (const role of MANAGEMENT) {
    const list = await apiRequest("/api/payments", { cookie: cookies[role] });
    assert.equal(list.status, 200, role);
    assert.equal((await apiRequest(`/api/payments/${pay.id}`, { cookie: cookies[role] })).status, 200, role);
    assert.equal((await apiRequest(`/api/cash-handoffs/${h.data.id}`, { cookie: cookies[role] })).status, 200, role);
    assert.ok((await shortfallIds(cookies[role])).includes(sf.id), role);
  }
  for (const role of ["warehouse_manager", "delivery_manager"]) {
    assert.equal((await apiRequest(`/api/payments/${pay.id}`, { cookie: cookies[role] })).status, 403, role);
    const list = await apiRequest(`/api/payments?customer_id=${customerA.id}`, { cookie: cookies[role] });
    assert.ok(!JSON.stringify(list.data).includes(`"id":${pay.id},`), `${role} list does not carry the payment`);
    assert.equal((await apiRequest(`/api/cash-handoffs/${h.data.id}`, { cookie: cookies[role] })).status, 403, role);
    assert.ok(!(await shortfallIds(cookies[role])).includes(sf.id), role);
  }
  // the rep who handed it over still sees his own; another rep does not
  assert.equal((await apiRequest(`/api/payments/${pay.id}`, { cookie: cookies.sales_manager })).status, 200);
  assert.equal((await apiRequest(`/api/cash-handoffs/${h.data.id}`, { cookie: cookies.sales_manager })).status, 200);
  assert.ok((await shortfallIds(cookies.sales_manager)).includes(sf.id));
  assert.equal((await apiRequest(`/api/payments/${pay.id}`, { cookie: repBCookie })).status, 403);
  assert.equal((await apiRequest(`/api/cash-handoffs/${h.data.id}`, { cookie: repBCookie })).status, 403);
  assert.ok(!(await shortfallIds(repBCookie)).includes(sf.id));
});

// ---- 0.14 supplier costs -----------------------------------------------------------------------------------------------------------------
test("0.14: the catalogue and the product card carry no cost key for a role that may not see costs", async () => {
  const product = await createProduct();
  await pool.query("UPDATE products SET gold_price_amd = 900, landing_cost_amd = 700, net_cost_amd = 800, pack_cost_usd = 2.5, landing_workbook_amd = 650, landing_source = 'workbook' WHERE id = $1", [product.id]);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager"]) {
    const list = await apiRequest("/api/products", { cookie: cookies[role] });
    const row = list.data.find((p) => p.id === product.id);
    const card = (await apiRequest(`/api/products/${product.id}`, { cookie: cookies[role] })).data;
    for (const shown of [row, card]) {
      assert.ok(shown, role);
      for (const key of PRODUCT_COST_FIELDS) assert.ok(!(key in shown), `${role} got ${key}`);
      assert.ok(!("net_cost_workbook_amd" in shown), role);
      assert.equal(shown.name, product.name, "the rest is still there");
    }
  }
  const rep = (await apiRequest(`/api/products/${product.id}`, { cookie: cookies.sales_manager })).data;
  assert.equal(rep.effective_standard_amd, 1000, "prices are still computed for the rep");
  for (const role of ["admin", "ceo", "operations_director", "sales_director", "accountant"]) {
    const card = (await apiRequest(`/api/products/${product.id}`, { cookie: cookies[role] })).data;
    assert.equal(Number(card.pack_cost_usd), 2.5, role);
    assert.equal(Number(card.landing_workbook_amd), 650, role);
  }
});

test("0.14: every products column is named once -- allowed for all, or a cost field (a new column needs that decision)", async () => {
  const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND table_schema = current_schema()");
  const both = PRODUCT_FIELDS_FOR_ALL.filter((f) => PRODUCT_COST_FIELDS.includes(f));
  assert.deepEqual(both, [], "a field in both lists");
  const unnamed = rows.map((r) => r.column_name).filter((c) => !PRODUCT_FIELDS_FOR_ALL.includes(c) && !PRODUCT_COST_FIELDS.includes(c));
  assert.deepEqual(unnamed, [], "add each new products column to PRODUCT_FIELDS_FOR_ALL or PRODUCT_COST_FIELDS (src/products/routes/products.js)");
});
