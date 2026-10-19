// Ask KAD (the admin's AI analyst): runs the real engine against the test database with a FAKE model, and checks the
// promises that matter: names never leave the server, the answer comes back with real names, the data tools
// return codes and the right numbers, the monthly cap stops new questions, and only admin may use it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { askKad, AskError } from "../../src/askKad/engine.js";
import { runTool } from "../../src/askKad/tools.js";
import { loadNameBook, maskText, unmaskText } from "../../src/askKad/anonymize.js";

const ERP = "90871";
const NAME = "Zorbak Motors Garage";
const REP_NAME = "Vahagn Testyan";
const TODAY = "2026-10-15";
let admin, rep, customer, adminCookie, repCookie, savedSettings;

test.before(async () => {
  await startTestServer();
  // The suite also runs against the production database on deploy: remember the real settings, restore them in test.after.
  savedSettings = (await pool.query("SELECT ask_kad_enabled, ask_kad_monthly_cap_usd FROM app_settings WHERE id = 1")).rows[0];
  await pool.query("UPDATE app_settings SET ask_kad_enabled = TRUE, ask_kad_monthly_cap_usd = 20 WHERE id = 1");
  admin = await createUser("admin");
  rep = await createUser("sales_manager", { name: REP_NAME });
  customer = await createCustomer({ created_by: admin.id, name: NAME, erp_customer_id: ERP });
  await pool.query("UPDATE customers SET region = 'Kotayk' WHERE id = $1", [customer.id]);
  // Two invoices: one in the current window, one a year back (so the customer also shows up as "lapsed").
  const line = (orderId, date, qty, revenue) =>
    pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd, sales_rep)
       VALUES ($1, $2, $3, 'zp1', 'Castrol', 'Magnatec 5W-30', '4', $4, 10000, $5, 0, 'SM YVN')`,
      [ERP, orderId, date, qty, revenue]
    );
  await line("ZT-1", "2026-10-05", 5, 50000);
  await line("ZT-2", "2026-03-01", 10, 100000);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, aging_bucket, days_since_payment) VALUES ($1, $2, 250000, 'd31_60', 45)", [ERP, NAME]);
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
});
test.after(async () => {
  await pool.query("DELETE FROM ask_kad_log WHERE user_id = $1 OR question_masked LIKE '%ZT-TEST%'", [admin.id]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP]);
  await pool.query("UPDATE app_settings SET ask_kad_enabled = $1, ask_kad_monthly_cap_usd = $2 WHERE id = 1", [savedSettings.ask_kad_enabled, savedSettings.ask_kad_monthly_cap_usd]);
  await cleanupAll();
  await stopTestServer();
});

// A scripted stand-in for the Anthropic client: step 1 asks for two tools, step 2 answers using the codes it saw.
function fakeModel() {
  const seen = [];
  const replies = [
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [
        { type: "text", text: "Looking it up." },
        { type: "tool_use", id: "t1", name: "sales", input: { from: "2026-10-01", to: TODAY, group_by: "customer", limit: 50 } },
        { type: "tool_use", id: "t2", name: "debt", input: { limit: 5 } },
      ],
    },
    {
      stop_reason: "end_turn",
      usage: { input_tokens: 2000, output_tokens: 300 },
      content: [{ type: "text", text: "• CUST-90871 owes 250,000 դր\nRecommended action: ask REP-X to call CUST-90871." }],
    },
  ];
  let i = 0;
  return {
    seen,
    beta: {
      messages: {
        create: async (params) => {
          seen.push(JSON.parse(JSON.stringify(params)));
          return replies[Math.min(i++, replies.length - 1)];
        },
      },
    },
  };
}

test("names never reach the model; the answer comes back with real names; the request is logged with its cost", async () => {
  const model = fakeModel();
  const out = await askKad({
    question: `How is ${NAME} doing? (ZT-TEST) Also ask ${REP_NAME} about it.`,
    history: [{ role: "user", text: `earlier: tell me about ${NAME}` }, { role: "assistant", text: `${NAME} is a Kotayk garage.` }],
    userId: admin.id,
    client: model,
    now: new Date("2026-10-15T08:00:00Z"),
  });

  const everythingSent = JSON.stringify(model.seen);
  assert.ok(!everythingSent.includes("Zorbak"), "customer name leaked to the model");
  assert.ok(!everythingSent.includes("Vahagn"), "staff name leaked to the model");
  assert.ok(!everythingSent.includes("Testyan"), "staff name leaked to the model");
  assert.ok(everythingSent.includes("CUST-90871"), "customer code missing");
  assert.ok(everythingSent.includes(`REP-${rep.id}`), "rep code missing");
  assert.ok(everythingSent.includes("Today (Yerevan): 2026-10-15"));

  // The tool results (second request) carry codes and the real numbers, no names.
  const toolResults = model.seen[1].messages.at(-1).content;
  assert.equal(toolResults.length, 2, "both tool results go back in ONE user message");
  const sales = JSON.parse(toolResults[0].content);
  const mine = sales.rows.find((r) => r.customer === "CUST-90871");
  assert.equal(mine.revenue_amd, 50000);
  assert.equal(mine.liters, 20);
  assert.equal(mine.orders, 1);
  assert.ok(sales.total.revenue_amd >= 50000);
  const debt = JSON.parse(toolResults[1].content);
  assert.ok(debt.biggest.some((d) => d.customer === "CUST-90871" && d.debt_amd === 250000 && d.aging_bucket === "d31_60"));

  assert.ok(out.answer.includes(NAME), "the code was not turned back into the real name");
  assert.ok(!out.answer.includes("CUST-90871"));
  assert.ok(out.maskedNames >= 3);
  assert.deepEqual(out.tools.sort(), ["debt", "sales"]);
  // 3000 in x $4 + 500 out x $20 per million
  assert.equal(out.costUsd, 0.022);

  const { rows } = await pool.query("SELECT * FROM ask_kad_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [admin.id]);
  assert.equal(rows[0].input_tokens, 3000);
  assert.ok(!rows[0].question_masked.includes("Zorbak"));
  assert.deepEqual(rows[0].tools.sort(), ["debt", "sales"]);
});

test("the monthly cap stops new questions, and the switch turns the feature off", async () => {
  await pool.query("UPDATE app_settings SET ask_kad_monthly_cap_usd = 0.01 WHERE id = 1");
  await assert.rejects(askKad({ question: "hi", userId: admin.id, client: fakeModel(), now: new Date("2026-10-15T08:00:00Z") }), (e) => e instanceof AskError && e.code === "cap_reached");
  await pool.query("UPDATE app_settings SET ask_kad_monthly_cap_usd = 20, ask_kad_enabled = FALSE WHERE id = 1");
  await assert.rejects(askKad({ question: "hi", userId: admin.id, client: fakeModel() }), (e) => e instanceof AskError && e.code === "disabled");
  await pool.query("UPDATE app_settings SET ask_kad_enabled = TRUE WHERE id = 1");
});

test("a refusal or a stuck model ends cleanly with a coded error", async () => {
  const refusing = { beta: { messages: { create: async () => ({ stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 }, content: [] }) } } };
  await assert.rejects(askKad({ question: "x", userId: admin.id, client: refusing }), (e) => e.code === "refused");
  const looping = {
    beta: { messages: { create: async () => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "x", name: "nope", input: {} }] }) } },
  };
  await assert.rejects(askKad({ question: "x", userId: admin.id, client: looping }), (e) => e.code === "too_many_steps");
});

test("tools: lapsed customers, plan vs actual and unknown tool", async () => {
  const lapsed = JSON.parse((await runTool("lapsed_customers", { min_days: 60, region: "kotayk" }, { today: TODAY })).content);
  const row = lapsed.customers.find((c) => c.customer === "CUST-90871");
  assert.equal(row, undefined, "ordered 10 days ago, not lapsed");
  const lapsed2 = JSON.parse((await runTool("lapsed_customers", { min_days: 60, limit: 50 }, { today: "2027-03-01" })).content);
  const gone = lapsed2.customers.find((c) => c.customer === "CUST-90871");
  assert.equal(gone.days_since_last_order, 147);
  assert.equal(gone.revenue_in_year_before_amd, 150000);
  assert.equal(gone.orders_in_year_before, 2);
  assert.ok(lapsed2.customers.every((c) => c.customer.startsWith("CUST-")));
  const plan = JSON.parse((await runTool("plan_vs_actual", { month: "2031-01" }, { today: TODAY })).content);
  assert.equal(plan.plan_found, false);
  const bad = await runTool("drop_database", {}, { today: TODAY });
  assert.equal(bad.isError, true);
  const badDates = await runTool("sales", { from: "2026-10-10", to: "2026-10-01" }, { today: TODAY });
  assert.equal(badDates.isError, true);
});

test("name masking: longest name first, brand words are protected, unknown codes are left alone", async () => {
  const book = await loadNameBook();
  const { text, count } = maskText(`compare ${NAME.toUpperCase()} and castrol`, book);
  assert.equal(count, 1);
  assert.ok(text.includes("CUST-90871") && text.includes("castrol"));
  assert.equal(unmaskText("CUST-90871 and CUST-NOSUCH", book), `${NAME} and CUST-NOSUCH`);
});

test("only admin can use it; without an API key it says so", async () => {
  const forRep = await apiRequest("/api/ask-kad/status", { cookie: repCookie });
  assert.equal(forRep.status, 403);
  const status = await apiRequest("/api/ask-kad/status", { cookie: adminCookie });
  assert.equal(status.status, 200);
  assert.equal(status.data.cap_usd, 20);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await apiRequest("/api/ask-kad", { method: "POST", cookie: adminCookie, body: { question: "hello" } });
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "not_configured");
    const bad = await apiRequest("/api/ask-kad", { method: "POST", cookie: adminCookie, body: { question: "" } });
    assert.equal(bad.status, 400);
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
  const settings = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ask_kad_monthly_cap_usd: 35 } });
  assert.equal(settings.data.ask_kad_monthly_cap_usd, 35);
  const tooHigh = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ask_kad_monthly_cap_usd: 99999 } });
  assert.equal(tooHigh.status, 400);
});
