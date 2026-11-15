// Vaghinak - Sales Expert, step 3: the weekly AI market strategy (team/vaghinak/strategist.js). The AI service is a fake here: the tests check
// what would be SENT (no customer name, no phone number) and what is stored and shown (names back, the talking point tied to its customer),
// plus who may read and run it. Nothing ever reaches the real service.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { generateStrategy, runWeeklyStrategy, cleanFreeText, normalizeReport } from "../../src/team/vaghinak/strategist.js";
import { loadNameBook, customerCode } from "../../src/team/askKad/anonymize.js";

const tag = `ST${Date.now()}`;
const SHOP = `Strategy Shop ${tag}`;
let admin, director, rep, shop, cookies = {};
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  for (const [k, u] of Object.entries({ admin, director, rep })) cookies[k] = await loginAs(u.email);
  shop = await createCustomer({ name: SHOP, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `${tag}1` });
  await pool.query("UPDATE customers SET customer_tier = 'potential', potential_level = 4 WHERE id = $1", [shop.id]);
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, note, brand_status, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], $3, '{"competitors":["mobil"]}'::jsonb, now() - interval '1 day')`,
    [shop.id, rep.id, `Owner of ${SHOP} wants a better price than Mobil, call him on +374 91 234 567`]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM sales_strategy_reports");
  await pool.query("DELETE FROM checkins WHERE customer_id = $1", [shop.id]);
  await cleanupAll();
  await stopTestServer();
});

test("free text loses names and long numbers before it is sent", async () => {
  const book = await loadNameBook(pool);
  const out = cleanFreeText(`${SHOP} paid, phone 091-23-45-67, TIN 02612345, 4 L x 12`, book);
  assert.ok(!out.text.includes(SHOP), out.text);
  assert.ok(out.text.includes(customerCode(`${tag}1`, shop.id)));
  assert.ok(!out.text.includes("02612345") && !out.text.includes("091-23-45-67"), out.text);
  assert.ok(out.text.includes("4 L x 12"), "short numbers stay");
});

test("a malformed answer becomes a safe, bounded report", () => {
  const r = normalizeReport({ headline: 5, situation: ["a", 3, ""], actions: [{ what: "do" }, { who: "x" }], talking_points: [{ rep: "REP-1", points: [] }] });
  assert.deepEqual([r.headline, r.situation, r.actions.length, r.talking_points.length], ["", ["a"], 1, 0]);
});

test("one run: nothing identifying is sent, the stored report has the names back and the talking point knows its customer", async () => {
  const code = customerCode(`${tag}1`, shop.id);
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = init.body;
    return new Response(
      JSON.stringify({
        model: "gpt-5",
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify({ headline: `${code} is close to a first order`, situation: ["x"], actions: [{ who: `REP-${rep.id}`, what: `visit ${code}` }], talking_points: [{ rep: `REP-${rep.id}`, customer: code, points: ["bring the price list"] }] }) } }],
      }),
      { status: 200 }
    );
  };
  const row = await generateStrategy({ db: pool, fetchImpl, apiKey: "test", userId: admin.id });
  assert.ok(sent, "the service was called");
  assert.ok(!sent.includes(SHOP), "the shop name is never sent");
  assert.ok(!sent.includes("234 567") && !sent.includes("+374"), "the phone is never sent");
  assert.ok(sent.includes(code), "the shop goes as its code");
  assert.ok(row.report.headline.includes(SHOP), "the code is turned back into the name");
  assert.equal(row.report.talking_points[0].customer_id, shop.id);
  assert.ok(row.cost_usd > 0 && row.input_tokens === 1000);

  // the screen reads it; a rep may not; only the owner's circle may run it, and never twice within an hour
  const got = await apiRequest("/api/funnel/strategy", { cookie: cookies.director });
  assert.equal(got.status, 200);
  assert.equal(got.data.report.id, row.id);
  assert.equal((await apiRequest("/api/funnel/strategy", { cookie: cookies.rep })).status, 403);
  assert.equal((await apiRequest("/api/funnel/strategy/run", { method: "POST", cookie: cookies.director })).status, 403);
  const before = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    assert.equal((await apiRequest("/api/funnel/strategy/run", { method: "POST", cookie: cookies.admin })).status, 503, "no key, no run");
    assert.deepEqual(await runWeeklyStrategy(new Date(), pool), { skipped: "not_configured" });
    process.env.OPENAI_API_KEY = "test-key-never-used";
    // a report was just made: refused before any call to the service
    assert.equal((await apiRequest("/api/funnel/strategy/run", { method: "POST", cookie: cookies.admin })).status, 429);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test("a service error stores nothing", async () => {
  await pool.query("DELETE FROM sales_strategy_reports");
  await assert.rejects(generateStrategy({ db: pool, apiKey: "test", fetchImpl: async () => new Response("no", { status: 500 }) }));
  await assert.rejects(generateStrategy({ db: pool, apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 }) }));
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM sales_strategy_reports")).rows[0].n, 0);
});
