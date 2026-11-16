// Vaghinak - Sales Expert, step 3: the weekly AI market strategy (team/vaghinak/strategist.js). The AI service is a fake here: the tests check
// what would be SENT (no customer name, no phone number) and what is stored and shown (names back, the talking point tied to its customer),
// plus who may read and run it. Nothing ever reaches the real service.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { generateStrategy, runWeeklyStrategy, cleanFreeText, normalizeReport, strategyNameBook, claimStrategyRun } from "../../src/team/vaghinak/strategist.js";
import { customerCode } from "../../src/team/askKad/anonymize.js";
import { mondayOf } from "../../src/team/vaghinak/digest.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

const tag = `ST${Date.now()}`;
const SHOP = `Strategy Shop ${tag}`;
const FIRST = `Vardanush${tag.replace(/\d/g, (d) => "abcdefghij"[d])}`; // a staff first name (letters only, like a real one)
let admin, director, rep, shop, cookies = {};
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  rep = await createUser("sales_manager", { name: `${FIRST} Petrosyan` });
  for (const [k, u] of Object.entries({ admin, director, rep })) cookies[k] = await loginAs(u.email);
  shop = await createCustomer({ name: SHOP, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `${tag}1` });
  await pool.query("UPDATE customers SET customer_tier = 'potential', potential_level = 4 WHERE id = $1", [shop.id]);
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, note, brand_status, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], $3, '{"competitors":["mobil"]}'::jsonb, now() - interval '1 day')`,
    [shop.id, rep.id, `Owner of ${SHOP} wants a better price than Mobil, call him on +374 91 234 567 or 093.12.34.56, shop@example.am, @shopgram, www.shop.am. ${FIRST}ը will come back`]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM sales_strategy_reports");
  await pool.query("DELETE FROM sales_strategy_runs");
  await pool.query("DELETE FROM sales_step_picks WHERE customer_id = $1", [shop.id]);
  await pool.query("DELETE FROM checkins WHERE customer_id = $1", [shop.id]);
  await cleanupAll();
  await stopTestServer();
});

test("free text loses names and long numbers before it is sent", async () => {
  const book = await strategyNameBook(pool);
  const out = cleanFreeText(`${SHOP} paid, phone 091-23-45-67, TIN 02612345, 4 L x 12`, book);
  assert.ok(!out.text.includes(SHOP), out.text);
  assert.ok(out.text.includes(customerCode(`${tag}1`, shop.id)));
  assert.ok(!out.text.includes("02612345") && !out.text.includes("091-23-45-67"), out.text);
  assert.ok(out.text.includes("4 L x 12"), "short numbers stay");
  // a staff member written by first name with an Armenian ending, emails, links, handles, phones with dots
  const more = cleanFreeText(`${FIRST}ը said: mail a@b.am, see www.x.am or https://x.am/p, @insta_shop, 093.12.34.56`, book);
  assert.ok(!more.text.includes(FIRST) && more.text.includes(`REP-${rep.id}`), more.text);
  for (const leak of ["a@b.am", "www.x.am", "https://x.am", "@insta_shop", "093.12.34.56"]) assert.ok(!more.text.includes(leak), `${leak}: ${more.text}`);
});

test("a malformed answer becomes a safe, bounded report", () => {
  const r = normalizeReport({ headline: 5, situation: ["a", 3, ""], actions: [{ what: "do" }, { who: "x" }], talking_points: [{ rep: "REP-1", points: [] }] });
  assert.deepEqual([r.headline, r.situation, r.actions.length, r.talking_points.length], ["", ["a"], 1, 0]);
});

test("one run: nothing identifying is sent, the stored report has the names back and the talking point knows its customer", async () => {
  const code = customerCode(`${tag}1`, shop.id);
  // this week's pick of the shop, saved with its own details (they win over the customer's step of today)
  await pool.query(
    `INSERT INTO sales_step_picks (week_start, customer_id, rep_id, kind, params, value) VALUES ($1, $2, $3, 'add_group', '{"group":"Transmission"}', 100)
     ON CONFLICT (week_start, customer_id) DO UPDATE SET kind = EXCLUDED.kind, params = EXCLUDED.params`,
    [mondayOf(yerevanToday()), shop.id, rep.id]
  );
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
  for (const leak of ["093.12.34.56", "shop@example.am", "@shopgram", "www.shop.am", FIRST]) assert.ok(!sent.includes(leak), leak);
  assert.ok(JSON.parse(sent).max_completion_tokens > 0, "the answer length is capped");
  const input = JSON.parse(JSON.parse(sent).messages[1].content);
  const pick = input.this_week_picks.find((p) => p.customer === code);
  assert.deepEqual([pick?.step, pick?.step_details], ["add_group", { group: "Transmission" }], "the pick goes with its own saved details");
  assert.ok(row.report.headline.includes(SHOP), "the code is turned back into the name");
  assert.deepEqual(row.report.talking_points[0].customer_ids, [shop.id]);
  const run = (await pool.query("SELECT status, input_tokens, cost_usd::float8 AS cost FROM sales_strategy_runs ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual([run.status, run.input_tokens], ["done", 1000]);
  assert.ok(run.cost > 0);
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
    // a run was just made: refused before any call to the service
    assert.equal((await apiRequest("/api/funnel/strategy/run", { method: "POST", cookie: cookies.admin })).status, 429);
    // switched off: refused on the server too (not only a hidden button)
    await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: cookies.admin, body: { strategistMode: "off" } });
    try {
      assert.equal((await apiRequest("/api/funnel/strategy/run", { method: "POST", cookie: cookies.admin })).status, 409);
    } finally {
      await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: cookies.admin, body: { strategistMode: "shadow" } });
    }
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test("a failed run stores no report but is counted (with what it cost); never two runs at once", async () => {
  await pool.query("DELETE FROM sales_strategy_reports");
  await pool.query("DELETE FROM sales_strategy_runs");
  await assert.rejects(generateStrategy({ db: pool, apiKey: "test", fetchImpl: async () => new Response("no", { status: 500 }) }));
  await assert.rejects(
    generateStrategy({ db: pool, apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 8000 }, choices: [{ message: { content: "not json" } }] }), { status: 200 }) })
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM sales_strategy_reports")).rows[0].n, 0);
  const runs = (await pool.query("SELECT status, output_tokens, cost_usd::float8 AS cost FROM sales_strategy_runs ORDER BY id")).rows;
  assert.deepEqual(runs.map((r) => r.status), ["failed", "failed"]);
  assert.ok(runs[1].output_tokens === 8000 && runs[1].cost > 0, "a paid answer that could not be read still shows its cost");
  // one run is going: a second one is refused before any call
  const id = await claimStrategyRun({ db: pool });
  await assert.rejects(claimStrategyRun({ db: pool }), (err) => err.status === 409);
  await assert.rejects(generateStrategy({ db: pool, apiKey: "test", fetchImpl: async () => assert.fail("must not be called") }), (err) => err.status === 409);
  await pool.query("UPDATE sales_strategy_runs SET status = 'failed' WHERE id = $1", [id]);
});

test("talking points at the check-in: the shop's own rep only once switched on, never another rep's shop; management always", async () => {
  const other = await createUser("sales_manager");
  const otherCookie = await loginAs(other.email);
  await pool.query("DELETE FROM sales_strategy_reports");
  await pool.query(
    `INSERT INTO sales_strategy_reports (week_start, model, report) VALUES ($1, 'gpt-5', $2::jsonb)`,
    [mondayOf(yerevanToday()), JSON.stringify({ talking_points: [{ rep: `REP-${rep.id}`, customer: "CUST-x", customer_ids: [shop.id], points: ["bring the price list"] }] })]
  );
  const get = (who) => apiRequest(`/api/sales-points/${shop.id}`, { cookie: who });
  try {
    assert.deepEqual((await get(cookies.rep)).data.points, [], "off by default");
    assert.deepEqual((await get(cookies.director)).data.points, ["bring the price list"], "management reads them");
    await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: cookies.admin, body: { strategyRepPoints: "on" } });
    assert.deepEqual((await get(cookies.rep)).data.points, ["bring the price list"], "on: the shop's own rep reads them");
    assert.equal((await get(otherCookie)).status, 404, "another rep's shop reads like no shop");
    assert.equal((await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: cookies.director, body: { strategyRepPoints: "off" } })).status, 403, "a director cannot switch it");
  } finally {
    await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: cookies.admin, body: { strategyRepPoints: "off" } });
  }
});
