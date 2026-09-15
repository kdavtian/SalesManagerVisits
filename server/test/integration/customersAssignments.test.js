// API coverage for Customers and assignments (server/src/routes/customers.js):
// valid create, Armenia-bounds/tier/payment-method/credit-term boundary
// validation, the soft near-duplicate warning + confirm_duplicate override,
// the hard erp_customer_id uniqueness conflict, reassignment/finance-field
// role gating on PATCH, unauthenticated access, and the payments
// ON DELETE RESTRICT surfacing as a clean 409 instead of a raw FK error.
//
// Real logins are cached once in test.before() and reused, the same
// IP-rate-limit-budget pattern established in auth.test.js/usersRoles.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let cookies;
let users;

// A point safely inside the app's Armenia bounding box (central Yerevan).
const YEREVAN = { lat: 40.18, lng: 44.51 };
// Well outside it (Tbilisi, Georgia).
const OUTSIDE_ARMENIA = { lat: 41.72, lng: 44.79 };

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_director", "accountant"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- Valid requests -----------------------------------------------------------

test("POST /api/customers: a valid submission creates a customer, defaulting assigned_manager_id to the creator", async () => {
  const res = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Valid Shop ${Date.now()}`, ...YEREVAN },
  });
  assert.equal(res.status, 201);
  trackCustomer(res.data.id);
  assert.equal(res.data.assigned_manager_id, users.sales_manager.id);
  assert.equal(res.data.customer_tier, "potential");
});

// --- Invalid / boundary input --------------------------------------------------

test("POST /api/customers: missing name/lat/lng is a 400", async () => {
  const res = await apiRequest("/api/customers", { method: "POST", cookie: cookies.sales_manager, body: { name: "No Coords" } });
  assert.equal(res.status, 400);
});

test("POST /api/customers: lat/lng outside Armenia is rejected", async () => {
  const res = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Outside ${Date.now()}`, ...OUTSIDE_ARMENIA },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /outside Armenia/);
});

test("POST /api/customers: an invalid customer_tier is a 400", async () => {
  // normalizeCustomerPortfolio (app.js, ahead of this router) silently
  // coerces customer_tier to "potential" whenever no erp_customer_id is
  // given -- an erp_customer_id must be present here for an explicit
  // (invalid) tier to actually reach this router's own CUSTOMER_TIERS check.
  const res = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Badtier ${Date.now()}`, ...YEREVAN, customer_tier: "platinum", erp_customer_id: `ITEST-BADTIER-${Date.now()}` },
  });
  assert.equal(res.status, 400);
});

test("POST /api/customers: an invalid payment_method is a 400", async () => {
  const res = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Badpay ${Date.now()}`, ...YEREVAN, payment_method: "crypto" },
  });
  assert.equal(res.status, 400);
});

test("POST /api/customers: credit_term_days must be a positive whole number", async () => {
  const res = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Badcredit ${Date.now()}`, ...YEREVAN, credit_term_days: 0 },
  });
  assert.equal(res.status, 400);
});

// --- Duplicate detection (soft warning + override) -----------------------------

test("POST /api/customers: a near-duplicate name+location is a 409 duplicate_warning; confirm_duplicate overrides it", async () => {
  const name = `Itest Dup Shop ${Date.now()}`;
  const first = await apiRequest("/api/customers", { method: "POST", cookie: cookies.sales_manager, body: { name, ...YEREVAN } });
  assert.equal(first.status, 201);
  trackCustomer(first.data.id);

  const warned = await apiRequest("/api/customers", { method: "POST", cookie: cookies.sales_manager, body: { name, ...YEREVAN } });
  assert.equal(warned.status, 409);
  assert.equal(warned.data.error, "duplicate_warning");
  assert.equal(warned.data.similar_customer.id, first.data.id);

  const overridden = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name, ...YEREVAN, confirm_duplicate: true },
  });
  assert.equal(overridden.status, 201, "confirm_duplicate must bypass the soft warning");
  trackCustomer(overridden.data.id);
});

// --- Hard erp_customer_id uniqueness conflict -----------------------------------

test("POST /api/customers: a duplicate erp_customer_id is a clean 409, not a raw DB error", async () => {
  const erpId = `ITEST-ERP-${Date.now()}`;
  const first = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest ERP A ${Date.now()}`, ...YEREVAN, erp_customer_id: erpId },
  });
  assert.equal(first.status, 201);
  trackCustomer(first.data.id);
  assert.equal(first.data.customer_tier, "bronze", "an ERP id at creation auto-starts the customer at Bronze");

  const conflict = await apiRequest("/api/customers", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest ERP B ${Date.now()}`, lat: YEREVAN.lat + 0.5, lng: YEREVAN.lng + 0.5, erp_customer_id: erpId },
  });
  assert.equal(conflict.status, 409);
});

// --- Reassignment / finance-field role gating on PATCH --------------------------

test("PATCH /api/customers/:id: reassigning region/manager requires canReassignCustomers -- sales_manager is 403, sales_director succeeds", async () => {
  const customer = await createCustomer({ created_by: users.sales_manager.id });
  const other = await createUser("sales_manager");

  const denied = await apiRequest(`/api/customers/${customer.id}`, {
    method: "PATCH",
    cookie: cookies.sales_manager,
    body: { assigned_manager_id: other.id },
  });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest(`/api/customers/${customer.id}`, {
    method: "PATCH",
    cookie: cookies.sales_director,
    body: { assigned_manager_id: other.id },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.assigned_manager_id, other.id);
});

test("PATCH /api/customers/:id: a sales_manager CAN edit their own customer's sales_channel", async () => {
  const customer = await createCustomer({ created_by: users.sales_manager.id });
  const res = await apiRequest(`/api/customers/${customer.id}`, {
    method: "PATCH",
    cookie: cookies.sales_manager,
    body: { sales_channel: "retail" },
  });
  assert.equal(res.status, 200);
});

test("PATCH /api/customers/:id: finance fields (credit_term_days/payment_method) require seesFinancialExports -- sales_manager is 403, accountant succeeds", async () => {
  const customer = await createCustomer({ created_by: users.sales_manager.id });

  const denied = await apiRequest(`/api/customers/${customer.id}`, {
    method: "PATCH",
    cookie: cookies.sales_manager,
    body: { credit_term_days: 60 },
  });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest(`/api/customers/${customer.id}`, {
    method: "PATCH",
    cookie: cookies.accountant,
    body: { credit_term_days: 60 },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.credit_term_days, 60);
});

test("PATCH /api/customers/:id: a nonexistent id is a 404", async () => {
  const res = await apiRequest("/api/customers/999999999", { method: "PATCH", cookie: cookies.admin, body: { sales_channel: "retail" } });
  assert.equal(res.status, 404);
});

// --- Unauthenticated ------------------------------------------------------------

test("GET and POST /api/customers reject an unauthenticated request with 401", async () => {
  const getRes = await apiRequest("/api/customers");
  assert.equal(getRes.status, 401);
  const postRes = await apiRequest("/api/customers", { method: "POST", body: { name: "X", ...YEREVAN } });
  assert.equal(postRes.status, 401);
});

// --- DB constraint failures -------------------------------------------------------

test("DELETE /api/customers/:id: a customer with recorded payments can't be deleted -- clean 409, not a raw FK error", async () => {
  const customer = await createCustomer({ created_by: users.admin.id });
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
     VALUES ($1, $2, 1000, now(), $3, $4, 'pending', $3) RETURNING id`,
    [customer.id, customer.name, users.admin.id, users.admin.name]
  );
  trackPayment(rows[0].id);

  const res = await apiRequest(`/api/customers/${customer.id}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(res.status, 409);
});

test("DELETE /api/customers/:id: a nonexistent id is a 404", async () => {
  const res = await apiRequest("/api/customers/999999999", { method: "DELETE", cookie: cookies.admin });
  assert.equal(res.status, 404);
});

test("DELETE /api/customers/:id: only admin (requireAdmin) may delete -- sales_director is 403", async () => {
  const customer = await createCustomer({ created_by: users.admin.id });
  const res = await apiRequest(`/api/customers/${customer.id}`, { method: "DELETE", cookie: cookies.sales_director });
  assert.equal(res.status, 403);
});
