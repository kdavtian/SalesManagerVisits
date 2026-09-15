// API coverage for Reports and exports: server/src/routes/reports.js
// (canAccessReport/requireReportAccess -- role-gated, admin-overridable via
// report_access) and server/src/routes/exports.js (seesFinancialExports --
// entirely unpaginated CSVs, so a genuine large-export test matters here).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;

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

// --- Reports: role gating ----------------------------------------------------------

test("GET /api/reports: lists only the reports each role can access (a plain sales_manager sees none by default)", async () => {
  const asManager = await apiRequest("/api/reports", { cookie: cookies.sales_manager });
  assert.equal(asManager.status, 200);
  assert.deepEqual(asManager.data, [], "no report currently defaults sales_manager into its viewer list");

  const asAdmin = await apiRequest("/api/reports", { cookie: cookies.admin });
  assert.equal(asAdmin.status, 200);
  assert.ok(asAdmin.data.length > 0, "admin always sees every report (canAccessReport short-circuits true for admin)");
});

test("GET /api/reports/checkins: a sales_manager gets 403; sales_director (a default viewer) gets 200", async () => {
  const denied = await apiRequest("/api/reports/checkins", { cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest("/api/reports/checkins", { cookie: cookies.sales_director });
  assert.equal(allowed.status, 200);
});

test("GET /api/reports/* rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/reports/checkins");
  assert.equal(res.status, 401);
});

// --- Exports: role gating (seesFinancialExports) ------------------------------------

test("GET /api/exports/payments.csv: a sales_manager gets 403; an accountant gets a real CSV", async () => {
  const denied = await apiRequest("/api/exports/payments.csv", { cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest("/api/exports/payments.csv", { cookie: cookies.accountant });
  assert.equal(allowed.status, 200);
  assert.ok(String(allowed.data).includes("date,rep,customer,amount_amd"));
});

test("GET /api/exports/* rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/exports/orders.csv");
  assert.equal(res.status, 401);
});

// --- Large export: every row present, correct summary footer -----------------------

test("GET /api/exports/orders.csv: a large export (120 line items) includes every row and an accurate per-status summary footer", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct({ unit_price_amd: 500 });
  const ROW_COUNT = 120;
  const isoDay = "2020-06-15"; // a fixed, isolated day nothing else in this suite touches

  const { rows: orderRows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method, created_at)
     VALUES ($1, $2, 'delivered', $3, 0, 0, 'not_required', $4, 'cash', $5::date) RETURNING id`,
    [customer.id, manager.id, 500 * ROW_COUNT, `ITEST-BIGEXPORT-${Date.now()}`, isoDay]
  );
  const orderId = orderRows[0].id;
  trackOrder(orderId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ROW_COUNT; i++) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, 500, 1, 500)`,
        [orderId, product.id, `${product.name} #${i}`, product.brand ?? null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const res = await apiRequest(`/api/exports/orders.csv?from=${isoDay}&to=${isoDay}`, { cookie: cookies.accountant });
  assert.equal(res.status, 200);

  const text = String(res.data).replace(/^﻿/, "");
  const lines = text.trim().split("\r\n");
  const header = lines[0];
  assert.equal(header, "order_id,date,status,rep,customer,product,price_source,quantity,unit_price_amd,line_total_amd");

  const dataLines = lines.slice(1, 1 + ROW_COUNT);
  assert.equal(dataLines.length, ROW_COUNT, "every one of the 120 line items must appear, not truncated by pagination");
  assert.ok(dataLines.every((l) => l.startsWith(`${orderId},`)), "every data row must belong to this order");

  const summaryLines = lines.slice(1 + ROW_COUNT);
  assert.ok(summaryLines.some((l) => l === `Rows,${ROW_COUNT}`), "the summary footer's row count must match exactly");
  assert.ok(summaryLines.some((l) => l === `delivered rows,${ROW_COUNT}`));
  assert.ok(summaryLines.some((l) => l === `delivered line_total_amd,${500 * ROW_COUNT}`));
});
