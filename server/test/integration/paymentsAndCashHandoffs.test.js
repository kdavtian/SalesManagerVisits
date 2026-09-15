// API coverage for Payments and cash handoffs (server/src/routes/payments.js,
// server/src/routes/cashHandoffs.js): valid submission, MAX_AMOUNT boundary,
// the advisory-lock duplicate_warning + confirm_duplicate override, a real
// CONCURRENT double-submission via Promise.all (exactly one 201 + one 409),
// role gating on submitting for others, the cash-custody chain's
// validHandoffRecipientRoles boundary, and the FOR UPDATE-based concurrency
// safety of "submit all" (exactly one submitter wins, the other gets 409).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;
let customer;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_manager2", "sales_director", "ceo", "accountant", "delivery_manager"]) {
    const actualRole = role === "sales_manager2" ? "sales_manager" : role;
    users[role] = await createUser(actualRole);
    cookies[role] = await loginAs(users[role].email);
  }
  customer = await createCustomer({ created_by: users.sales_manager.id });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// Inserts a "pending, currently held by holderId, not in a handoff" payment
// row directly via SQL -- fast fixture setup for the cash-handoff tests
// below, which need real available cash rather than exercising POST /
// itself again.
async function seedAvailablePayment(holderId, amount = 5000) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
     VALUES ($1, $2, $3, now(), $4, $5, 'pending', $4, $4) RETURNING id`,
    [customer.id, customer.name, amount, holderId, "Fixture Rep"]
  );
  trackPayment(rows[0].id);
  return rows[0].id;
}

// --- Payments: valid requests + boundary ------------------------------------------

test("POST /api/payments: a sales_manager can submit a valid payment for themselves", async () => {
  const res = await apiRequest("/api/payments", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, amount_amd: 12345 },
  });
  assert.equal(res.status, 201);
  trackPayment(res.data.id);
  assert.equal(res.data.sales_manager_id, users.sales_manager.id);
});

test("POST /api/payments: amount_amd must be positive and under MAX_AMOUNT", async () => {
  const zero = await apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, amount_amd: 0 } });
  assert.equal(zero.status, 400);

  const tooLarge = await apiRequest("/api/payments", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, amount_amd: 100000000000 },
  });
  assert.equal(tooLarge.status, 400, "amount_amd >= MAX_AMOUNT must be rejected");
});

test("POST /api/payments: a nonexistent customer_id is a 400", async () => {
  const res = await apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: 999999999, amount_amd: 1000 } });
  assert.equal(res.status, 400);
});

// --- Duplicate detection: soft warning + override ----------------------------------

test("POST /api/payments: a same customer/amount submission within the window is a 409 duplicate_warning; confirm_duplicate overrides", async () => {
  const amount = 77777;
  const first = await apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, amount_amd: amount } });
  assert.equal(first.status, 201);
  trackPayment(first.data.id);

  const warned = await apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, amount_amd: amount } });
  assert.equal(warned.status, 409);
  assert.equal(warned.data.error, "duplicate_warning");

  const overridden = await apiRequest("/api/payments", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, amount_amd: amount, confirm_duplicate: true },
  });
  assert.equal(overridden.status, 201);
  trackPayment(overridden.data.id);
});

// --- Concurrent duplicate submission: exactly one 201, one 409 ---------------------

test("POST /api/payments: two truly concurrent identical submissions -- the advisory lock lets exactly one through, the other gets 409", async () => {
  const amount = 88888;
  const body = { customer_id: customer.id, amount_amd: amount };

  const [a, b] = await Promise.all([
    apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body }),
    apiRequest("/api/payments", { method: "POST", cookie: cookies.sales_manager, body }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], "exactly one concurrent submission must succeed and the other must be flagged as a duplicate");

  const created = a.status === 201 ? a : b;
  trackPayment(created.data.id);

  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM payments WHERE customer_id = $1 AND amount_amd = $2 AND sales_manager_id = $3",
    [customer.id, amount, users.sales_manager.id]
  );
  assert.equal(rows[0].n, 1, "only one payment row must actually exist, whatever order the two requests resolved in");
});

// --- Role gating: submitting for others ---------------------------------------------

test("POST /api/payments: a role without canSubmitPaymentsForOthers (delivery_manager) gets 403", async () => {
  const res = await apiRequest("/api/payments", { method: "POST", cookie: cookies.delivery_manager, body: { customer_id: customer.id, amount_amd: 1000 } });
  assert.equal(res.status, 403);
});

test("POST /api/payments: a sales_director CAN submit on behalf of a named sales manager", async () => {
  const res = await apiRequest("/api/payments", {
    method: "POST",
    cookie: cookies.sales_director,
    body: { customer_id: customer.id, amount_amd: 33333, sales_manager_id: users.sales_manager.id },
  });
  assert.equal(res.status, 201);
  trackPayment(res.data.id);
  assert.equal(res.data.sales_manager_id, users.sales_manager.id);
});

// --- Unauthenticated -----------------------------------------------------------------

test("POST /api/payments rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/payments", { method: "POST", body: { customer_id: customer.id, amount_amd: 1000 } });
  assert.equal(res.status, 401);
});

// --- Cash handoffs: valid submission + recipient-role boundary ----------------------

test("POST /api/cash-handoffs: a sales_manager can hand their available cash to a sales_director", async () => {
  const paymentId = await seedAvailablePayment(users.sales_manager.id);

  const res = await apiRequest("/api/cash-handoffs", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { to_user_id: users.sales_director.id, payment_ids: [paymentId] },
  });
  assert.equal(res.status, 201);
  trackHandoff(res.data.id);
  assert.equal(res.data.status, "pending");
  assert.equal(res.data.item_count, 1);
});

test("POST /api/cash-handoffs: a sales_manager can only hand off to a sales_director -- sending to ceo directly is a 400", async () => {
  const paymentId = await seedAvailablePayment(users.sales_manager.id);
  const res = await apiRequest("/api/cash-handoffs", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { to_user_id: users.ceo.id, payment_ids: [paymentId] },
  });
  assert.equal(res.status, 400);
});

test("POST /api/cash-handoffs: a role without canSubmitHandoffForOthers cannot declare on someone else's behalf", async () => {
  const res = await apiRequest("/api/cash-handoffs", {
    method: "POST",
    cookie: cookies.delivery_manager,
    body: { to_user_id: users.sales_director.id, on_behalf_of_user_id: users.sales_manager.id, all: true },
  });
  assert.equal(res.status, 403);
});

test("POST /api/cash-handoffs: nothing available to select is a 409", async () => {
  const freshManager = await createUser("sales_manager");
  const res = await apiRequest("/api/cash-handoffs", {
    method: "POST",
    cookie: cookies.sales_director,
    body: { to_user_id: users.sales_director.id, all: true, on_behalf_of_user_id: freshManager.id },
  });
  assert.equal(res.status, 409);
});

// --- Concurrent "submit all": FOR UPDATE serializes, only one wins ------------------

test("POST /api/cash-handoffs: two concurrent 'submit all' taps from the same sender -- exactly one succeeds, the other finds nothing left", async () => {
  await seedAvailablePayment(users.sales_manager2.id, 4000);
  await seedAvailablePayment(users.sales_manager2.id, 6000);

  const body = { to_user_id: users.sales_director.id, all: true };
  const [a, b] = await Promise.all([
    apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager2, body }),
    apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager2, body }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], "exactly one concurrent 'submit all' must succeed; the other must find nothing left (FOR UPDATE serialized them)");

  const created = a.status === 201 ? a : b;
  trackHandoff(created.data.id);
  assert.equal(created.data.item_count, 2, "the winner must claim BOTH available payments, not just one");
});

// --- Unauthenticated -----------------------------------------------------------------

test("POST /api/cash-handoffs rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/cash-handoffs", { method: "POST", body: { to_user_id: users.sales_director.id, all: true } });
  assert.equal(res.status, 401);
});
