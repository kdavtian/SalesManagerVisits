// Owner, 2026-11-19: "When management or sales director wants to change something, no need to request approval if he can approve as
// well." Whoever may decide a kind of request does not ask anyone for their own change: discount, credit limit, customer card, own visit
// plan, monthly plan, new competitor brand -- approved at once, in their name. A rep's same change still waits. Made-up data only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const people = {};
const cookies = {};
let customer;
const planIds = [];
const tag = `Zs${Date.now().toString(36)}`;

test.before(async () => {
  await startTestServer();
  for (const role of ["sales_manager", "sales_director", "ceo", "admin"]) {
    people[role] = await createUser(role, { name: `Self ${role}` });
    cookies[role] = await loginAs(people[role].email);
  }
  customer = await createCustomer({ created_by: people.sales_manager.id, assigned_manager_id: people.sales_manager.id, name: `${tag} Shop`, erp_customer_id: `itest-self-${people.sales_manager.id}` });
});
test.after(async () => {
  if (planIds.length) await pool.query("DELETE FROM visit_plans WHERE id = ANY($1)", [planIds]);
  await pool.query("DELETE FROM competitor_brands WHERE lower(name) LIKE lower($1)", [`${tag}%`]);
  await cleanupAll();
  await stopTestServer();
});

const order = async (who, body) => {
  const r = await apiRequest("/api/orders", { method: "POST", cookie: cookies[who], body: { customer_id: customer.id, payment_method: "cash", ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackOrder(r.data.id);
  return r.data;
};
const pendingRequests = async (who) => (await apiRequest("/api/requests", { cookie: cookies[who] })).data?.items ?? [];

test("a discount: the sales director's own is approved in their name; a rep's waits; the director's later edit of it is theirs too", async () => {
  const product = await createProduct({ unit_price_amd: 10000 });
  const mine = await order("sales_director", { items: [{ product_id: product.id, quantity: 2 }], discount_pct: 10 });
  assert.equal(mine.approval_status, "approved");
  assert.equal(mine.approved_by, people.sales_director.id);
  const { rows: hist } = await pool.query("SELECT reason FROM order_status_history WHERE order_id = $1", [mine.id]);
  assert.ok(hist.some((h) => /approved by the person who set it/.test(h.reason)));
  assert.ok(!(await pendingRequests("ceo")).some((r) => r.kind === "discount" && r.id === mine.id), "nobody is asked");

  const reps = await order("sales_manager", { items: [{ product_id: product.id, quantity: 2 }], discount_pct: 10 });
  assert.equal(reps.approval_status, "pending", "a rep's discount still waits");
  // the director changes the discount: their own decision
  const changed = await apiRequest(`/api/orders/${reps.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { discount_pct: 8 } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data).slice(0, 300));
  assert.deepEqual([changed.data.approval_status, changed.data.approved_by], ["approved", people.sales_director.id]);
});

test("a customer card change: the sales director's is saved at once; a rep's waits", async () => {
  const own = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_director, body: { customer_id: customer.id, changes: { address: `${tag} street 1` } } });
  assert.equal(own.status, 201);
  assert.deepEqual([own.data.status, own.data.reviewed_by], ["approved", people.sales_director.id]);
  assert.equal((await pool.query("SELECT address FROM customers WHERE id = $1", [customer.id])).rows[0].address, `${tag} street 1`);

  const reps = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, changes: { address: `${tag} street 2` } } });
  assert.equal(reps.data.status, "pending");
  assert.equal((await pool.query("SELECT address FROM customers WHERE id = $1", [customer.id])).rows[0].address, `${tag} street 1`);
});

test("a visit plan for their own day: approved for the sales director and the CEO; a rep's waits", async () => {
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  for (const [who, expected] of [["sales_director", "approved"], ["ceo", "approved"], ["sales_manager", "pending"]]) {
    const r = await apiRequest("/api/visit-plans", { method: "POST", cookie: cookies[who], body: { date: day, customer_ids: [customer.id] } });
    assert.ok([200, 201].includes(r.status), `${who}: ${JSON.stringify(r.data)}`);
    planIds.push(r.data.id);
    assert.equal(r.data.status, expected, who);
  }
});

test("a new competitor brand: added by the CEO is approved at once; by a rep it waits", async () => {
  const byCeo = await apiRequest("/api/competitor-brands", { method: "POST", cookie: cookies.ceo, body: { name: `${tag} Alpha` } });
  assert.equal(byCeo.data.brand.status, "approved");
  const byRep = await apiRequest("/api/competitor-brands", { method: "POST", cookie: cookies.sales_manager, body: { name: `${tag} Beta` } });
  assert.equal(byRep.data.brand.status, "pending");
});

test("a monthly plan: the CEO's own is approved at once; the sales director's still goes for review", async () => {
  const { rows: [ch] } = await pool.query("SELECT id FROM sales_channels ORDER BY id LIMIT 1");
  const plans = [];
  try {
    for (const [who, month, expected] of [["ceo", "2099-03-01", "approved"], ["sales_director", "2099-04-01", "pending_approval"]]) {
      const made = await apiRequest("/api/team-performance/plans", { method: "POST", cookie: cookies[who], body: { month } });
      assert.equal(made.status, 201, JSON.stringify(made.data).slice(0, 200));
      const id = made.data.plan?.id ?? made.data.id;
      plans.push(id);
      await pool.query("INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd) VALUES ($1, $2, 1000)", [id, ch.id]);
      const sent = await apiRequest(`/api/team-performance/plans/${id}/submit`, { method: "POST", cookie: cookies[who] });
      assert.equal(sent.status, 200, JSON.stringify(sent.data).slice(0, 200));
      assert.equal(sent.data.status, expected, who);
    }
  } finally {
    if (plans.length) {
      await pool.query("DELETE FROM perf_plan_targets WHERE plan_id = ANY($1)", [plans]);
      await pool.query("DELETE FROM perf_plan_audit WHERE plan_id = ANY($1)", [plans]);
      await pool.query("DELETE FROM perf_plans WHERE id = ANY($1)", [plans]);
    }
  }
});

test("a director saving the whole card (only the phone changed) does not overwrite a rep's waiting request for the address", async () => {
  const shop = await createCustomer({ created_by: people.sales_manager.id, assigned_manager_id: people.sales_manager.id, name: `${tag} Two` });
  await pool.query("UPDATE customers SET address = $2, phone = NULL WHERE id = $1", [shop.id, `${tag} old`]);
  const reps = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: shop.id, changes: { address: `${tag} new` } } });
  assert.equal(reps.data.status, "pending");
  const own = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_director, body: { customer_id: shop.id, changes: { name: `${tag} Two`, address: `${tag} old`, phone: "+37499000111" } } });
  assert.equal(own.status, 201);
  assert.deepEqual(Object.keys(own.data.changes), ["phone"], "only the changed field is written");
  assert.equal((await pool.query("SELECT status FROM customer_edit_requests WHERE id = $1", [reps.data.id])).rows[0].status, "pending", "the rep's request still waits");
  // nothing changed at all: nothing written
  const none = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_director, body: { customer_id: shop.id, changes: { address: `${tag} old` } } });
  assert.equal(none.data.unchanged, true);
});
