// Owner, 2026-11-05: the sales director reviews customer card edit requests, tier changes included (it was admin only).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep;
let director;
let accountant;
let cookies;
let customer;

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  cookies = { rep: await loginAs(rep.email), director: await loginAs(director.email), accountant: await loginAs(accountant.email) };
  customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: `ITEST-CER-${Date.now()}` });
});
test.after(async () => {
  await pool.query("DELETE FROM customer_edit_requests WHERE customer_id = $1", [customer.id]);
  await cleanupAll();
  await stopTestServer();
});

test("a rep proposes a tier change; the sales director sees the queue and approves it; a rep or the accountant cannot review", async () => {
  const proposed = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.rep, body: { customer_id: customer.id, changes: { customer_tier: "silver" } } });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
  const id = proposed.data.id;

  // the queue is for reviewers only
  assert.equal((await apiRequest("/api/edit-requests?status=pending", { cookie: cookies.rep })).status, 403);
  assert.equal((await apiRequest("/api/edit-requests?status=pending", { cookie: cookies.accountant })).status, 403);
  const queue = await apiRequest("/api/edit-requests?status=pending", { cookie: cookies.director });
  assert.equal(queue.status, 200);
  assert.ok(queue.data.some((r) => r.id === id));
  assert.equal(queue.data.find((r) => r.id === id).current.customer_tier, customer.customer_tier ?? "potential", "the reviewer sees what the field holds now");
  const own = await apiRequest(`/api/edit-requests?customer_id=${customer.id}&status=pending`, { cookie: cookies.rep });
  assert.equal(own.data[0].current, undefined, "the proposer only gets the banner, no current values");
  const badge = await apiRequest("/api/badges", { cookie: cookies.director });
  assert.ok(badge.data.editRequests >= 1);

  assert.equal((await apiRequest(`/api/edit-requests/${id}`, { method: "PATCH", cookie: cookies.rep, body: { action: "approve" } })).status, 403);
  assert.equal((await apiRequest(`/api/edit-requests/${id}`, { method: "PATCH", cookie: cookies.accountant, body: { action: "approve" } })).status, 403);
  const ok = await apiRequest(`/api/edit-requests/${id}`, { method: "PATCH", cookie: cookies.director, body: { action: "approve" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "approved");
  const { rows } = await pool.query("SELECT customer_tier FROM customers WHERE id = $1", [customer.id]);
  assert.equal(rows[0].customer_tier, "silver");
  assert.equal((await apiRequest(`/api/edit-requests/${id}`, { method: "PATCH", cookie: cookies.director, body: { action: "approve" } })).status, 409, "already reviewed");
});

test("the sales director can reject too", async () => {
  const proposed = await apiRequest("/api/edit-requests", { method: "POST", cookie: cookies.rep, body: { customer_id: customer.id, changes: { notes: "new note" } } });
  const rejected = await apiRequest(`/api/edit-requests/${proposed.data.id}`, { method: "PATCH", cookie: cookies.director, body: { action: "reject", reason: "wrong phone" } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, "rejected");
});
