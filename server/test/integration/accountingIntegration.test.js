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
  assert.equal(found.items[0].brand, "Castrol");

  // A test-mode token never sees real orders.
  const testList = await apiRequest("/api/integration/v1/orders", { headers: bearer(testTok.token) });
  assert.equal(testList.data.orders.some((o) => o.id === ref), false);
  assert.equal((await apiRequest(`/api/integration/v1/orders/${ref}`, { headers: bearer(testTok.token) })).status, 404);

  // Claim is atomic: second claim is a 409.
  const claim = await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: bearer(token) });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.waybill_status, "in_progress");
  const claimAgain = await apiRequest(`/api/integration/v1/orders/${ref}/claim`, { method: "POST", headers: bearer(token) });
  assert.equal(claimAgain.status, 409);
  assert.equal(claimAgain.data.error.code, "not_pending");

  // Management can no longer change the request once Lily has it.
  const locked = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: { payment_method: "invoice" } });
  assert.equal(locked.status, 409);

  // Report documents -- idempotent on Idempotency-Key.
  const docsBody = { waybills: [{ number: "WB-1", hc_id: "HC-77", date: "2026-10-06", brand: "Castrol", source_warehouse: "03", destination_warehouse: "04", lines: [{ line_id: found.items[0].line_id, quantity: 2 }] }] };
  const idemHeaders = bearer(token, { "Idempotency-Key": `itest-${orderId}-docs` });
  const rep1 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: idemHeaders, body: docsBody });
  assert.equal(rep1.status, 200);
  assert.equal(rep1.data.waybill_status, "document_created");
  assert.equal(rep1.data.documents.length, 1);
  const rep2 = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: idemHeaders, body: docsBody });
  assert.equal(rep2.status, 200);
  assert.equal(rep2.data.documents.length, 1);
  const badDoc = await apiRequest(`/api/integration/v1/orders/${ref}/waybills`, { method: "POST", headers: bearer(token), body: { waybills: [{ number: "X" }] } });
  assert.equal(badDoc.status, 400);

  // SRC export result, then signed.
  const exported = await apiRequest(`/api/integration/v1/orders/${ref}/export`, { method: "POST", headers: bearer(token), body: { number: "WB-1", status: "exported_unsigned" } });
  assert.equal(exported.data.waybill_status, "exported_unsigned");
  const signed = await apiRequest(`/api/integration/v1/orders/${ref}/export`, { method: "POST", headers: bearer(token), body: { number: "WB-1", status: "signed" } });
  assert.equal(signed.data.waybill_status, "signed");

  // The app sees the result on the order.
  const detail = await apiRequest(`/api/orders/${orderId}`, { cookie });
  assert.equal(detail.data.accounting_status, "signed");
  assert.equal(detail.data.accounting_documents[0].number, "WB-1");

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
  const problem = await apiRequest(`/api/integration/v1/orders/${ref}/problem`, {
    method: "POST",
    headers: h,
    body: { code: "insufficient_stock", message: "Not enough stock", details: { hc_code: "000010", missing: 1 } },
  });
  assert.equal(problem.data.waybill_status, "needs_attention");
  assert.equal(problem.data.error.code, "insufficient_stock");

  const retry = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie, body: {} });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.accounting_status, "pending");
  assert.equal(retry.data.accounting_error, null);

  // An invoice without a customer TIN is refused with a clear message.
  const noTin = await confirmedOrder({ payment_method: "invoice", tin: null });
  const refused = await apiRequest(`/api/orders/${noTin.orderId}/accounting-request`, { method: "POST", cookie: noTin.cookie, body: {} });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /TIN/);
});
