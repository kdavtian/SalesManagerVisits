// Customer tier and sales-channel policy (server/src/customerChannelPolicy.js,
// server/src/salesChannelAutofill.js).
import "dotenv/config"; // salesChannelAutofill.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCustomerPortfolio } from "../src/customerChannelPolicy.js";
import { channelFromPosition } from "../src/salesChannelAutofill.js";

function runMiddleware(fn, body) {
  const req = { body };
  let nextCalled = false;
  fn(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, "next() must always be called");
  return req.body;
}

// For the refusal case: returns { status, body } of the response the middleware sent instead of calling next().
function runRefusal(fn, body) {
  const req = { body };
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  fn(req, res, () => assert.fail("next() must not be called"));
  return out;
}

// --- normalizeCustomerPortfolio -------------------------------------------

test("normalizeCustomerPortfolio: a new customer with no ERP id and no tier defaults to potential", () => {
  const body = runMiddleware(normalizeCustomerPortfolio, {});
  assert.equal(body.customer_tier, "potential");
});

test("normalizeCustomerPortfolio: a customer with an ERP id is left alone (not forced to potential)", () => {
  const body = runMiddleware(normalizeCustomerPortfolio, { erp_customer_id: "12345", customer_tier: "gold" });
  assert.equal(body.customer_tier, "gold");
});

test("normalizeCustomerPortfolio: a competitor stays a competitor even with no ERP id", () => {
  const body = runMiddleware(normalizeCustomerPortfolio, { customer_tier: "competitor" });
  assert.equal(body.customer_tier, "competitor");
});

test("normalizeCustomerPortfolio: a blank/whitespace-only ERP id is treated as missing (Gold is refused, no tier becomes potential)", () => {
  const refused = runRefusal(normalizeCustomerPortfolio, { erp_customer_id: "   ", customer_tier: "gold" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /ERP customer ID is required/);
  assert.equal(runMiddleware(normalizeCustomerPortfolio, { erp_customer_id: "   " }).customer_tier, "potential");
});

test("normalizeCustomerPortfolio: Bronze, Silver or Gold without an ERP id is refused with a clear message", () => {
  for (const tier of ["bronze", "silver", "gold"]) {
    const refused = runRefusal(normalizeCustomerPortfolio, { customer_tier: tier });
    assert.equal(refused.status, 400, tier);
  }
});

// --- channelFromPosition ----------------------------------------------------

test("channelFromPosition: recognizes Davtashen in English and Armenian", () => {
  assert.equal(channelFromPosition("Sales Manager Davtashen"), "SM Davtashen");
  assert.equal(channelFromPosition("Վաճառքի մենեջեր Դավթաշեն"), "SM Davtashen");
});

test("channelFromPosition: recognizes Shirak/Gyumri in English and Armenian", () => {
  assert.equal(channelFromPosition("Sales Manager Shirak"), "SM Shirak");
  assert.equal(channelFromPosition("Gyumri rep"), "SM Shirak");
  assert.equal(channelFromPosition("Շիրակի մենեջեր"), "SM Shirak");
  assert.equal(channelFromPosition("Գյումրիի ներկայացուցիչ"), "SM Shirak");
});

test("channelFromPosition: recognizes B2B", () => {
  assert.equal(channelFromPosition("Sales Manager B2B"), "SM B2B");
});

test("channelFromPosition: recognizes the 'SM CAS' / 'Sales Manager CAS' position text", () => {
  assert.equal(channelFromPosition("Sales Manager CAS"), "SM CAS");
  assert.equal(channelFromPosition("SM CAS"), "SM CAS");
});

test("channelFromPosition: recognizes Yerevan in English and Armenian, and is checked after CAS", () => {
  assert.equal(channelFromPosition("Sales Manager Yerevan"), "SM YVN");
  assert.equal(channelFromPosition("Երևանի մենեջեր"), "SM YVN");
});

test("channelFromPosition: an unrecognized or empty position resolves to empty string, not a guess", () => {
  assert.equal(channelFromPosition("Warehouse Lead"), "");
  assert.equal(channelFromPosition(""), "");
  assert.equal(channelFromPosition(undefined), "");
});

test("channelFromPosition: matching is case-insensitive and trims whitespace", () => {
  assert.equal(channelFromPosition("  SALES MANAGER DAVTASHEN  "), "SM Davtashen");
});
