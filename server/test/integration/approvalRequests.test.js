// The request card (owner, 2026-11-08): every approver of a request gets ONE push opening #/requests/<kind>/<id>, the first decision
// closes it for the others, a denial needs a reason, the person who asked hears the result, and nobody else may open or decide it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const notesOf = async (userId, url) => (await pool.query("SELECT type, title, body, url, read_at FROM notifications WHERE user_id = $1 AND url = $2 ORDER BY id", [userId, url])).rows;

const people = {};
const cookies = {};
let customer;
const planIds = [];

test.before(async () => {
  await startTestServer();
  for (const role of ["sales_manager", "sales_director", "ceo", "operations_director", "accountant", "admin"]) {
    people[role] = await createUser(role, { name: `Req ${role}` });
    cookies[role] = await loginAs(people[role].email);
  }
  people.other_rep = await createUser("sales_manager", { name: "Req other rep" });
  cookies.other_rep = await loginAs(people.other_rep.email);
  customer = await createCustomer({ created_by: people.sales_manager.id, erp_customer_id: `itest-req-${people.sales_manager.id}`, name: "Req Customer" });
});
test.after(async () => {
  if (planIds.length) await pool.query("DELETE FROM visit_plans WHERE id = ANY($1)", [planIds]);
  await cleanupAll();
  await stopTestServer();
});

test("a customer card edit request: every approver gets one push to its card, others none", async () => {
  const made = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, changes: { phone: "+37491000111", customer_tier: "gold" }, note: "new owner" } });
  assert.equal(made.status, 201);
  const url = `/#/requests/customer_edit/${made.data.id}`;
  for (const role of ["sales_director", "ceo", "operations_director", "admin"]) {
    const rows = await waitFor(async () => {
      const r = await notesOf(people[role].id, url);
      return r.length ? r : null;
    });
    assert.equal(rows?.length, 1, `${role} gets exactly one`);
    assert.equal(rows[0].type, "approval_request");
    assert.match(rows[0].body, /Req Customer/);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await notesOf(people.accountant.id, url)).length, 0, "the accountant does not review card edits");
  assert.equal((await notesOf(people.sales_manager.id, url)).length, 0, "the requester is not asked to decide");

  // the card: full details for an approver, read-only for the requester, 403 for anyone else
  const card = await apiRequest(`/api/requests/customer_edit/${made.data.id}`, { cookie: cookies.sales_director });
  assert.equal(card.status, 200);
  assert.equal(card.data.can_decide, true);
  assert.equal(card.data.status, "pending");
  assert.equal(card.data.customer.erp_id, customer.erp_customer_id);
  assert.deepEqual(card.data.details.changes.find((c) => c.field === "customer_tier"), { field: "customer_tier", old: "potential", new: "gold" });
  const own = await apiRequest(`/api/requests/customer_edit/${made.data.id}`, { cookie: cookies.sales_manager });
  assert.equal(own.status, 200);
  assert.equal(own.data.can_decide, false);
  assert.equal((await apiRequest(`/api/requests/customer_edit/${made.data.id}`, { cookie: cookies.other_rep })).status, 403);
  assert.equal((await apiRequest(`/api/requests/customer_edit/${made.data.id}`, { cookie: cookies.accountant })).status, 403);
  // and the Requests list + badge of an approver hold it, an outsider's do not
  const list = await apiRequest("/api/requests", { cookie: cookies.ceo });
  assert.ok(list.data.items.some((i) => i.kind === "customer_edit" && i.id === made.data.id));
  assert.ok((await apiRequest("/api/badges", { cookie: cookies.ceo })).data.requests >= 1);
  assert.equal((await apiRequest("/api/requests", { cookie: cookies.other_rep })).data.total, 0);
  // a non-approver cannot decide it either (the kind's own endpoint)
  assert.equal((await apiRequest(`/api/edit-requests/${made.data.id}`, { method: "PATCH", cookie: cookies.other_rep, body: { action: "approve" } })).status, 403);

  // deny without a reason is refused; with one it is decided
  const bare = await apiRequest(`/api/edit-requests/${made.data.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { action: "reject" } });
  assert.equal(bare.status, 400);
  const denied = await apiRequest(`/api/edit-requests/${made.data.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { action: "reject", reason: "phone belongs to another shop" } });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.note, "new owner", "the requester's own note is kept");

  // the first decision closes it for the others
  assert.equal((await apiRequest(`/api/edit-requests/${made.data.id}`, { method: "PATCH", cookie: cookies.ceo, body: { action: "approve" } })).status, 409);
  const after = await apiRequest(`/api/requests/customer_edit/${made.data.id}`, { cookie: cookies.ceo });
  assert.equal(after.data.status, "rejected");
  assert.equal(after.data.can_decide, false);
  assert.equal(after.data.decided_by_name, "Req sales_director");
  assert.equal(after.data.decision_reason, "phone belongs to another shop");
  const ceoNote = await waitFor(async () => (await notesOf(people.ceo.id, url)).find((n) => n.read_at));
  assert.ok(ceoNote, "the other approvers' notification of it is read");

  // the requester hears the result, with the reason
  const result = await waitFor(async () => (await notesOf(people.sales_manager.id, url)).find((n) => n.type === "approval_result"));
  assert.ok(result);
  assert.match(result.title, /մերժվեց/);
  assert.match(result.body, /phone belongs to another shop/);
  assert.match(result.body, /Req sales_director/);
});

test("an order discount: its approvers get the request instead of a plain 'new order', a denial needs a reason, the rep hears the result", async () => {
  const product = await createProduct({ unit_price_amd: 10000 });
  const created = await apiRequest("/api/orders", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 2 }], payment_method: "cash", discount_pct: 10 } });
  assert.equal(created.status, 201);
  const orderId = trackOrder(created.data.id);
  assert.equal(created.data.approval_status, "pending");
  const url = `/#/requests/discount/${orderId}`;
  // no line has a net cost, so the operations director may approve it too (orderPricingAboveNetCost)
  for (const role of ["sales_director", "ceo", "operations_director", "admin"]) {
    const rows = await waitFor(async () => {
      const r = await notesOf(people[role].id, url);
      return r.length ? r : null;
    });
    assert.equal(rows?.length, 1, `${role} gets exactly one`);
    assert.equal(rows[0].type, "approval_request");
    assert.match(rows[0].body, /10%/);
  }
  await new Promise((r) => setTimeout(r, 300));
  const plain = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'order_placed' AND url = $2", [people.sales_director.id, `/#/orders?open=${orderId}`])).rows[0].n;
  assert.equal(plain, 0, "no second 'new order' push to someone asked to decide it");
  assert.equal((await notesOf(people.accountant.id, url)).length, 0);

  const card = await apiRequest(`/api/requests/discount/${orderId}`, { cookie: cookies.operations_director });
  assert.equal(card.data.can_decide, true);
  assert.equal(card.data.details.subtotal_amd, 20000);
  assert.equal(card.data.details.discount_amd, 2000);
  assert.equal(card.data.details.discount_pct, 10);
  assert.equal(card.data.amount_amd, 18000);
  assert.equal((await apiRequest(`/api/requests/discount/${orderId}`, { cookie: cookies.other_rep })).status, 403);

  assert.equal((await apiRequest(`/api/orders/${orderId}/reject-discount`, { method: "POST", cookie: cookies.ceo, body: {} })).status, 400);
  assert.equal((await apiRequest(`/api/orders/${orderId}/reject-discount`, { method: "POST", cookie: cookies.ceo, body: { reason: "  " } })).status, 400);
  const denied = await apiRequest(`/api/orders/${orderId}/reject-discount`, { method: "POST", cookie: cookies.ceo, body: { reason: "max 5% for this customer" } });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.approval_reason, "max 5% for this customer");
  assert.equal((await apiRequest(`/api/orders/${orderId}/approve-discount`, { method: "POST", cookie: cookies.sales_director })).status, 409, "already decided");
  const result = await waitFor(async () => (await notesOf(people.sales_manager.id, url)).find((n) => n.type === "order_status_changed"));
  assert.ok(result, "the rep hears it on the card's address");
  assert.match(result.body, /max 5% for this customer/);
  const after = await apiRequest(`/api/requests/discount/${orderId}`, { cookie: cookies.sales_director });
  assert.equal(after.data.status, "rejected");
  assert.equal(after.data.decided_by_name, "Req ceo");
});

test("a visit plan and a cash change: a denial without a reason is refused", async () => {
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const plan = await apiRequest("/api/visit-plans", { method: "POST", cookie: cookies.sales_manager, body: { date: day, customer_ids: [customer.id] } });
  assert.equal(plan.status, 201);
  planIds.push(plan.data.id);
  assert.equal(plan.data.status, "pending");
  const url = `/#/requests/visit_plan/${plan.data.id}`;
  const asked = await waitFor(async () => (await notesOf(people.sales_director.id, url))[0]);
  assert.equal(asked?.type, "plan_submitted");
  assert.equal((await apiRequest(`/api/visit-plans/${plan.data.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { action: "reject" } })).status, 400);
  assert.equal((await apiRequest(`/api/visit-plans/${plan.data.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { action: "reject", reason: "add the Ashtarak shops" } })).status, 200);
  const result = await waitFor(async () => (await notesOf(people.sales_manager.id, url)).find((n) => n.type === "plan_reviewed"));
  assert.match(result?.body ?? "", /Ashtarak/);
  const card = await apiRequest(`/api/requests/visit_plan/${plan.data.id}`, { cookie: cookies.ceo });
  assert.equal(card.data.decision_reason, "add the Ashtarak shops");
  assert.equal(card.data.details.plan_date, day);
  assert.equal(card.data.details.stops[0].name, "Req Customer");
});

test("a payment: its push still goes to the accountant only, every approver sees it in Requests, the rep hears the result", async () => {
  const paid = await apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, amount_amd: 15000 } });
  assert.equal(paid.status, 201);
  const id = paid.data.id;
  const url = `/#/requests/payment/${id}`;
  const asked = await waitFor(async () => (await notesOf(people.accountant.id, url))[0]);
  assert.equal(asked?.type, "payment_submitted");
  assert.equal((await notesOf(people.ceo.id, url)).length, 0, "CEO is not paged for every payment (PAYMENT_NOTIFY_ROLES)");
  assert.ok((await apiRequest("/api/requests", { cookie: cookies.ceo })).data.items.some((i) => i.kind === "payment" && i.id === id));
  assert.equal((await apiRequest(`/api/payments/${id}/reject`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 400);
  assert.equal((await apiRequest(`/api/payments/${id}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "no receipt" } })).status, 200);
  const result = await waitFor(async () => (await notesOf(people.sales_manager.id, url)).find((n) => n.type === "approval_result"));
  assert.match(result?.body ?? "", /no receipt/);
  assert.match(result?.body ?? "", /15,000 դր/);
  await pool.query("DELETE FROM payment_status_history WHERE payment_id = $1", [id]);
  await pool.query("DELETE FROM payments WHERE id = $1", [id]);
});

test("an unknown kind or id answers 404", async () => {
  assert.equal((await apiRequest("/api/requests/nonsense/1", { cookie: cookies.admin })).status, 404);
  assert.equal((await apiRequest("/api/requests/payment/999999999", { cookie: cookies.admin })).status, 404);
});
