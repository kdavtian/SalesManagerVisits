// Owner, 2026-10-27: the texts the customer reads before signing and the warning on every blank are editable (Settings > Sales &
// customers); a default visit frequency per customer type, which a customer's own frequency overrides.
// Isolated (own database): it changes app-wide settings.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { DOCUMENT_TEXT_DEFAULTS, signStatement } from "../../src/shared/documentTexts.js";
import { buildPaymentSlipsPdf } from "../../src/orders/orderBlankPdf.js";

let admin;
let rep;
let adminCookie;
let repCookie;
const freq = async (id) => (await pool.query("SELECT visit_frequency_days, visit_frequency_manual FROM customers WHERE id = $1", [id])).rows[0];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET visit_frequency_by_type = '{}', document_texts = '{}' WHERE id = 1");
  await pool.query("DELETE FROM orders WHERE user_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

test("visit frequency by customer type: the most frequent type wins, a hand-set frequency stays, empty = back to the default", async () => {
  const general = (await apiRequest("/api/settings", { cookie: adminCookie })).data.default_visit_frequency_days;
  const gold = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'gold', sales_channel = 'SM YVN' WHERE id = $1", [gold.id]);
  const own = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'gold', visit_frequency_days = 3 WHERE id = $1", [own.id]); // set by hand
  assert.equal((await freq(gold.id)).visit_frequency_days, general, "no type defaults yet");
  assert.deepEqual(await freq(own.id), { visit_frequency_days: 3, visit_frequency_manual: true });

  // only management saves it
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: repCookie, body: { visit_frequency_by_type: { gold: 5 } } })).status, 403);
  const bad = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { visit_frequency_by_type: { gold: 0 } } });
  assert.equal(bad.status, 400);
  const res = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { visit_frequency_by_type: { gold: 10, sm: 4 } } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.visit_frequency_by_type.gold, 10);
  assert.equal((await freq(gold.id)).visit_frequency_days, 4, "SM (4) is more frequent than Gold (10)");
  assert.equal((await freq(own.id)).visit_frequency_days, 3, "the customer's own frequency stays");

  // a change of type follows at once (the trigger), whoever writes it
  await pool.query("UPDATE customers SET sales_channel = 'KF' WHERE id = $1", [gold.id]);
  assert.equal((await freq(gold.id)).visit_frequency_days, 10, "KF has no default: Gold's 10");
  await pool.query("UPDATE customers SET customer_tier = 'potential', potential_level = 4 WHERE id = $1", [gold.id]);
  assert.equal((await freq(gold.id)).visit_frequency_days, general, "High potential has no default: the general one");
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { visit_frequency_by_type: { potential_4: 6 } } });
  assert.equal((await freq(gold.id)).visit_frequency_days, 6);

  // the edit sheet: a typed number makes it the customer's own; an emptied field brings it back to the type default
  assert.equal((await apiRequest(`/api/customers/${gold.id}`, { method: "PATCH", cookie: adminCookie, body: { visit_frequency_days: 20 } })).status, 200);
  assert.deepEqual(await freq(gold.id), { visit_frequency_days: 20, visit_frequency_manual: true });
  assert.equal((await apiRequest(`/api/customers/${gold.id}`, { method: "PATCH", cookie: adminCookie, body: { visit_frequency_days: null } })).status, 200);
  assert.deepEqual(await freq(gold.id), { visit_frequency_days: 6, visit_frequency_manual: false });
  // re-sending the same number (the edit sheet sends every field) is not "set by hand"
  await apiRequest(`/api/customers/${gold.id}`, { method: "PATCH", cookie: adminCookie, body: { visit_frequency_days: 6, notes: "x" } });
  assert.equal((await freq(gold.id)).visit_frequency_manual, false);
});

test("signature texts: editable, an empty text restores the original; the sentence fills in order, amount and the debt left", async () => {
  const before = (await apiRequest("/api/settings", { cookie: repCookie })).data;
  assert.equal(before.document_texts.pdf_warning, DOCUMENT_TEXT_DEFAULTS.pdf_warning);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: repCookie, body: { document_texts: { pdf_warning: "x" } } })).status, 403);
  const saved = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { document_texts: { pdf_warning: "ՆՈՐ ԶԳՈՒՇԱՑՈՒՄ" } } });
  assert.equal(saved.data.document_texts.pdf_warning, "ՆՈՐ ԶԳՈՒՇԱՑՈՒՄ");
  assert.equal(saved.data.document_texts.sign_order, DOCUMENT_TEXT_DEFAULTS.sign_order, "untouched texts stay");

  // the warning is printed on the PDFs
  const pdf = await buildPaymentSlipsPdf([{ number: "P-1", paidAt: new Date(), amountAmd: 1000, previousDebtAmd: 5000, customer: {}, rep: {} }], { warning: saved.data.document_texts.pdf_warning });
  const { execFileSync } = await import("node:child_process");
  assert.match(execFileSync("pdftotext", ["-", "-"], { input: pdf }).toString(), /ՆՈՐ ԶԳՈՒՇԱՑՈՒՄ/);

  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { document_texts: { pdf_warning: "" } } })).data.document_texts.pdf_warning, DOCUMENT_TEXT_DEFAULTS.pdf_warning);

  // the three sentences
  const texts = DOCUMENT_TEXT_DEFAULTS;
  assert.equal(signStatement(texts, { orderCodes: ["A-1"], balanceAfterAmd: 150000 }), "Սույնով հաստատում եմ, որ ստացա A-1 պատվերը: Պարտքի մնացորդը կազմում է 150,000 դրամ։");
  assert.equal(signStatement(texts, { paymentAmd: 45000, balanceAfterAmd: 0 }), "Սույնով հաստատում եմ, որ վճարեցի 45,000 դրամ: Պարտքի մնացորդը կազմում է 0 դրամ։");
  assert.equal(
    signStatement(texts, { orderCodes: ["A-1", "A-2"], paymentAmd: 5000, balanceAfterAmd: 10 }),
    "Սույնով հաստատում եմ, որ ստացա A-1, A-2 պատվերը և վճարեցի 5,000 դրամ: Պարտքի մնացորդը կազմում է 10 դրամ։"
  );
  assert.equal(signStatement(texts, { paymentAmd: 45000, balanceAfterAmd: null }), "Սույնով հաստատում եմ, որ վճարեցի 45,000 դրամ:", "no debt figure: the debt sentence is left out");

  // the endpoint: Excel debt 100,000 + this order 30,000 - 20,000 paid
  const c = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `DT${process.pid}` });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 100000)", [`DT${process.pid}`]);
  const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'packed_stock_out', 30000, 'DT-1') RETURNING id", [c.id, rep.id]);
  const st = (await apiRequest(`/api/customers/${c.id}/sign-statement?order_ids=${o.id}&payment=20000`, { cookie: repCookie })).data;
  assert.equal(st.balance_before_amd, 100000);
  assert.equal(st.balance_after_amd, 110000);
  assert.equal(st.statement, "Սույնով հաստատում եմ, որ ստացա DT-1 պատվերը և վճարեցի 20,000 դրամ: Պարտքի մնացորդը կազմում է 110,000 դրամ։");
  assert.ok(st.texts.sign_payment, "the texts come along for offline use");
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [`DT${process.pid}`]);
});
