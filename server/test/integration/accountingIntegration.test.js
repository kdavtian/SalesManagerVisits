// Lily (AI accountant) integration: management sends a confirmed order to
// accounting (waybill for cash, invoice for invoice orders), Lily pulls it
// with a bearer token, claims it, reports the documents / SRC export / a
// problem. Covers auth, test-mode isolation, idempotency and revocation.
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
  trackOrder,
} from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createIntegrationToken } from "../../src/integrationTokens.js";

const tokenIds = [];
test.before(startTestServer);
test.after(async () => {
  if (tokenIds.length) await pool.query("DELETE FROM integration_tokens WHERE id = ANY($1)", [tokenIds]);
  await cleanupAll();
  await stopTestServer();
});

const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

async function confirmedOrder({ payment_method, tin = "01234567" }) {
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: director.id, erp_customer_id: `itest-acc-${Date.now()}-${Math.random()}` });
  await pool.query("UPDATE customers SET tin = $2 WHERE id = $1", [customer.id, tin]);
  const product = await createProduct({ unit_price_amd: 2000 });
  await pool.query("UPDATE products SET sku = $2, hc_code = '000010', brand = 'Castrol' WHERE id = $1", [product.id, `SKU-${product.id}`]);
  const cookie = await loginAs(director.email);
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 2 }], payment_method },
  });
  assert.equal(created.status, 201);
  const orderId = trackOrder(created.data.id);
  const confirmed = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie, body: { status: "confirmed" } });
  assert.equal(confirmed.status, 200);
  return { director, cookie, customer, product, orderId };
}

test("accounting request, Lily's pull/claim/report flow, idempotency and revocation", async () => {
  const { cookie, orderId, product, customer } = await confirmedOrder({ payment_method: "cash" });
  const admin = await createUser("admin");
  const adminCookie = await loginAs(admin.email);
  const manager = await createUser("sales_manager");
  const managerCookie = await loginAs(manager.email);

  // Only management can send to accounting.
  const denied = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie: managerCookie, body: {} });
  assert.equal(denied.status, 403);

  // Admin issues the token (shown once) and a test token.
  const issued = await apiRequest("/api/integration-tokens", { method: "POST", cookie: adminCookie, body: { name: "Lily itest" } });
  assert.equal(issued.status, 201);
  tokenIds.push(issued.data.id);
  const token = issued.data.token;
  assert.match(token, /^kad_lily_/);
  const testTok = await createIntegrationToken({ name: "Lily itest (test)", testMode: true });
  tokenIds.push(testTok.id);

  // No / bad token -> 401 with the documented error shape.
  const noAuth = await apiRequest("/api/integration/v1/orders");
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.data.error.code, "unauthorized");
  assert.equal((await apiRequest("/api/integration/v1/orders", { headers: bearer("nope") })).status, 401);

  // Cash order -> waybill request (payment method kept).
  const requested = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.accounting_doc_type, "waybill");
  assert.equal(requested.data.accounting_status, "pending");

  // Management can still switch the method while it is pending -> invoice.
  const switched = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: { payment_method: "invoice" } });
  assert.equal(switched.status, 200);
  assert.equal(switched.data.accounting_doc_type, "invoice");
  assert.equal(switched.data.payment_method, "invoice");
  const back = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: { payment_method: "cash" } });
  assert.equal(back.data.accounting_doc_type, "waybill");

  // Lily lists pending orders: items carry hc_code/sku/qty/prices, customer carries erp id + tax id.
  const ref = `ord_${String(orderId).padStart(6, "0")}`;
  const list = await apiRequest("/api/integration/v1/orders?waybill_status=pending&limit=50", { headers: bearer(token) });
  assert.equal(list.status, 200);
  const found = list.data.orders.find((o) => o.id === ref);
  assert.ok(found, "pending order is listed");
  assert.equal(found.waybill_status, "pending");
  assert.equal(found.doc_type, "waybill");
  assert.equal(found.customer.tax_id, "01234567");
  assert.equal(found.customer.erp_customer_id, customer.erp_customer_id);
  assert.equal(found.items[0].hc_code, "000010");
  assert.equal(found.items[0].kad_sku, `SKU-${product.id}`);
  assert.equal(found.items[0].quantity, 2);
  assert.equal(found.items[0].unit_price_amd, 2000);
  assert.match(found.created_at, /\+04:00$/);
  assert.equal(found.items[0].brand, "Castrol");

  // A test-mode token never sees real orders.
  const testList = await apiRequest("/api/integration/v1/orders", { headers: bearer(testTok.token) });
  assert.equal(testList.data.orders.some((o) => o.id === ref), false);
  assert.equal((await apiRequest(`/api/integration/v1/orders/${ref}`, { headers: bearer(testTok.token) })).status, 404);

  // Claim is atomic: second claim is a 409.
  const claim = await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: bearer(token), body: { agent: "lily", claimed_at: "2026-10-05T19:40:00+04:00" } });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.waybill_status, "in_progress");
  const claimAgain = await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: bearer(token) });
  assert.equal(claimAgain.status, 409);
  assert.equal(claimAgain.data.error.code, "not_pending");

  // Management can no longer change the request once Lily has it.
  const locked = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: { payment_method: "invoice" } });
  assert.equal(locked.status, 409);

  // Two lines to cover: report only line 1 first -> partially_created.
  const lineId = found.items[0].line_id;
  const wbBody = (extra = {}) => ({
    waybills: [{ hc_doc_number: "255", hc_isn: "isn-1", date: "2026-10-06", warehouse_from: "03", warehouse_to: "04", brand: "Castrol", items: [{ line_id: lineId, hc_code: "000010", quantity: 2 }], created_at: "2026-10-05T19:41:30+04:00", ...extra }],
  });
  const idemHeaders = bearer(token, { "Idempotency-Key": `itest-${orderId}-255` });
  const rep1 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: idemHeaders, body: wbBody() });
  assert.equal(rep1.status, 200);
  assert.equal(rep1.data.waybill_status, "waybill_created");
  assert.equal(rep1.data.waybills.length, 1);
  const rep2 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: idemHeaders, body: wbBody() });
  assert.equal(rep2.status, 200);
  assert.equal(rep2.data.waybills.length, 1);
  const badDoc = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: bearer(token), body: { waybills: [{ hc_doc_number: "X" }] } });
  assert.equal(badDoc.status, 400);
  const badLine = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: bearer(token), body: wbBody({ hc_doc_number: "256", items: [{ line_id: "ln_0", quantity: 1 }] }) });
  assert.equal(badLine.status, 400);

  // SRC e-invoicing result per waybill, then a human signs it in KAD.
  const exported = await apiRequest(`/api/integration/v1/orders/${ref}/waybills/255/einvoicing`, { method: "POST", headers: bearer(token), body: { exported_at: "2026-10-05T19:42:10+04:00", status: "exported_unsigned" } });
  assert.equal(exported.data.waybill_status, "exported_unsigned");
  assert.equal((await apiRequest(`/api/integration/v1/orders/${ref}/waybills/999/einvoicing`, { method: "POST", headers: bearer(token), body: { status: "signed" } })).status, 404);
  const signedByHuman = await apiRequest(`/api/orders/${orderId}/accounting-signed`, { method: "POST", cookie, body: {} });
  assert.equal(signedByHuman.status, 200);
  assert.equal(signedByHuman.data.accounting_status, "signed");

  // The app sees the result on the order.
  const detail = await apiRequest(`/api/orders/${orderId}`, { cookie });
  assert.equal(detail.data.accounting_status, "signed");
  assert.equal(detail.data.accounting_documents[0].hc_doc_number, "255");

  // Product mapping, spec 3.6.
  const prods = await apiRequest("/api/integration/v1/products?updated_since=2020-01-01", { headers: bearer(token) });
  assert.ok(prods.data.products.some((p) => p.kad_sku === `SKU-${product.id}` && p.hc_code === "000010" && p.active === true));

  // Admin lists the audit trail; no plaintext token is stored.
  const audit = await apiRequest("/api/integration-tokens/audit?limit=200", { cookie: adminCookie });
  assert.ok(audit.data.some((a) => a.token_name === "Lily itest" && a.path.endsWith("/claim")));
  const tokenRows = await apiRequest("/api/integration-tokens", { cookie: adminCookie });
  assert.equal(JSON.stringify(tokenRows.data).includes(token), false);

  // Revoking stops the token immediately.
  const revoked = await apiRequest(`/api/integration-tokens/${issued.data.id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(revoked.status, 200);
  assert.equal((await apiRequest("/api/integration/v1/orders", { headers: bearer(token) })).status, 401);
});

test("problem report puts the order in needs_attention and management can retry; invoice needs a TIN", async () => {
  const { cookie, orderId } = await confirmedOrder({ payment_method: "invoice" });
  const issued = await createIntegrationToken({ name: "Lily itest 2" });
  tokenIds.push(issued.id);
  const h = bearer(issued.token);
  const ref = `ord_${String(orderId).padStart(6, "0")}`;

  const req = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(req.data.accounting_doc_type, "invoice");
  await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: h });
  const problem = await apiRequest(`/api/integration/v1/orders/${ref}/issue`, {
    method: "POST",
    headers: h,
    body: { code: "insufficient_stock", message: "Not enough stock", lines: [{ line_id: "ln_1", requested: 2, available: 1 }] },
  });
  assert.equal(problem.data.waybill_status, "needs_attention");
  const badIssue = await apiRequest(`/api/integration/v1/orders/${ref}/issue`, { method: "POST", headers: h, body: { code: "nope", message: "x" } });
  assert.equal(badIssue.status, 400);
  assert.equal(problem.data.issue.code, "insufficient_stock");

  const retry = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.accounting_status, "pending");
  assert.equal(retry.data.accounting_error, null);

  // A claim nobody reports on is released after 30 minutes.
  await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: h });
  await pool.query("UPDATE orders SET accounting_claimed_at = now() - interval '31 minutes' WHERE id = $1", [orderId]);
  const relisted = await apiRequest("/api/integration/v1/orders?waybill_status=pending", { headers: h });
  assert.ok(relisted.data.orders.some((o) => o.id === ref), "stale claim is pending again");

  // An invoice without a customer TIN is refused with a clear message.
  const noTin = await confirmedOrder({ payment_method: "invoice", tin: null });
  const refused = await apiRequest(`/api/orders/${noTin.orderId}/accounting-request`, { method: "POST", cookie: noTin.cookie, body: {} });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /TIN/);
});

test("two brands -> two waybills: partially_created until every line is covered", async () => {
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: director.id, erp_customer_id: `itest-acc2-${Date.now()}` });
  await pool.query("UPDATE customers SET tin = '01234567' WHERE id = $1", [customer.id]);
  const castrol = await createProduct({ unit_price_amd: 1000 });
  const royal = await createProduct({ unit_price_amd: 3000 });
  await pool.query("UPDATE products SET brand = 'Castrol', hc_code = '000010' WHERE id = $1", [castrol.id]);
  await pool.query("UPDATE products SET brand = 'Royal', hc_code = '000020' WHERE id = $1", [royal.id]);
  const cookie = await loginAs(director.email);
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: castrol.id, quantity: 1 }, { product_id: royal.id, quantity: 2 }], payment_method: "cash" },
  });
  const orderId = trackOrder(created.data.id);
  await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie, body: { status: "confirmed" } });
  await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  const issued = await createIntegrationToken({ name: "Lily itest 3" });
  tokenIds.push(issued.id);
  const h = bearer(issued.token);
  const ref = `ord_${String(orderId).padStart(6, "0")}`;
  const order = (await apiRequest(`/api/integration/v1/orders/${ref}`, { headers: h })).data;
  assert.equal(order.items.length, 2);
  await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: h });
  const lineOf = (brand) => order.items.find((i) => i.brand === brand);
  const first = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, {
    method: "POST",
    headers: h,
    body: { waybills: [{ hc_doc_number: "300", date: "2026-10-06", brand: "Castrol", warehouse_from: "03", warehouse_to: "04", items: [{ line_id: lineOf("Castrol").line_id, hc_code: "000010", quantity: 1 }] }] },
  });
  assert.equal(first.data.waybill_status, "partially_created");
  const second = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, {
    method: "POST",
    headers: h,
    body: { waybills: [{ hc_doc_number: "301", date: "2026-10-06", brand: "Royal", warehouse_from: "01", warehouse_to: "04", items: [{ line_id: lineOf("Royal").line_id, hc_code: "000020", quantity: 2 }] }] },
  });
  assert.equal(second.data.waybill_status, "waybill_created");
  assert.equal(second.data.waybills.length, 2);
  // Exporting one of two leaves the order at waybill_created; both -> exported_unsigned.
  const e1 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills/300/einvoicing`, { method: "POST", headers: h, body: { status: "exported_unsigned" } });
  assert.equal(e1.data.waybill_status, "waybill_created");
  const e2 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills/301/einvoicing`, { method: "POST", headers: h, body: { status: "exported_unsigned" } });
  assert.equal(e2.data.waybill_status, "exported_unsigned");
});

test("a waybill can only belong to a cash order and an invoice to an invoice order (database rule)", async () => {
  const { orderId } = await confirmedOrder({ payment_method: "invoice" });
  await assert.rejects(
    pool.query("UPDATE orders SET accounting_doc_type = 'waybill', accounting_status = 'pending' WHERE id = $1", [orderId]),
    /orders_accounting_doc_matches_payment/
  );
  await pool.query("UPDATE orders SET accounting_doc_type = 'invoice', accounting_status = 'pending' WHERE id = $1", [orderId]);
});

test("accounting requests group: list filter, manual request status (incl. cancelled) and re-sending", async () => {
  const { cookie, orderId } = await confirmedOrder({ payment_method: "cash" });
  const accountant = await createUser("accountant");
  const accCookie = await loginAs(accountant.email);
  const manager = await createUser("sales_manager");
  const managerCookie = await loginAs(manager.email);

  // Not sent yet -> not in the Accounting group.
  const before = await apiRequest("/api/orders?accounting=any", { cookie });
  assert.ok(!before.data.rows.some((o) => o.id === orderId));

  const sent = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(sent.status, 200);
  const any = await apiRequest("/api/orders?accounting=any", { cookie });
  assert.ok(any.data.rows.some((o) => o.id === orderId));
  const pending = await apiRequest("/api/orders?accounting=pending", { cookie });
  assert.ok(pending.data.rows.some((o) => o.id === orderId));
  // A sales manager has no Accounting group (the param is ignored for them).
  const mgrView = await apiRequest("/api/orders?accounting=pending", { cookie: managerCookie });
  assert.ok(!mgrView.data.rows.some((o) => o.id === orderId));

  // Change the request's condition by hand: management and the accountant can; a rep cannot.
  assert.equal((await apiRequest(`/api/orders/${orderId}/accounting-status`, { method: "POST", cookie: managerCookie, body: { status: "cancelled" } })).status, 403);
  assert.equal((await apiRequest(`/api/orders/${orderId}/accounting-status`, { method: "POST", cookie, body: { status: "bogus" } })).status, 400);
  const cancelled = await apiRequest(`/api/orders/${orderId}/accounting-status`, { method: "POST", cookie: accCookie, body: { status: "cancelled" } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.accounting_status, "cancelled");
  const inCancelled = await apiRequest("/api/orders?accounting=cancelled", { cookie });
  assert.ok(inCancelled.data.rows.some((o) => o.id === orderId));

  // A cancelled request can be sent again, and can be set back to pending.
  const again = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.data.accounting_status, "pending");
  const created = await apiRequest(`/api/orders/${orderId}/accounting-status`, { method: "POST", cookie, body: { status: "waybill_created" } });
  assert.equal(created.data.accounting_status, "waybill_created");
  const back = await apiRequest(`/api/orders/${orderId}/accounting-status`, { method: "POST", cookie, body: { status: "pending" } });
  assert.equal(back.data.accounting_status, "pending");
  assert.equal(back.data.accounting_claimed_at, null);
});
