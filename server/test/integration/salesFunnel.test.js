// Vaghinak - Sales Expert, step 1: the funnel from real rows (Excel order lines -> product groups and litres), the screen's API and its
// access, and the job that remembers moves between stages.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { recordFunnelMoves } from "../../src/team/vaghinak/funnel.js";

let admin, rep, adminCookie, repCookie;
const tag = `FN-${Date.now()}`;
const made = [];
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  await pool.query(
    `INSERT INTO products (name, unit_price_amd, erp_product_id, family) VALUES
     ('FN oil', 1000, $1, 'Edge'), ('FN atf', 1000, $2, 'Transmission'), ('FN brake', 1000, $3, 'Brake fluid')`,
    [`${tag}-1`, `${tag}-2`, `${tag}-3`]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id LIKE $1", [`${tag}%`]);
  await pool.query("DELETE FROM products WHERE erp_product_id LIKE $1", [`${tag}%`]);
  await cleanupAll();
  await stopTestServer();
});

async function customer(tier, { erp, level = null, expected = null } = {}) {
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erp ? `${tag}-${erp}` : null });
  await pool.query("UPDATE customers SET customer_tier = $2, potential_level = $3, expected_volume_l = $4 WHERE id = $1", [c.id, tier, level, expected]);
  made.push(c.id);
  return c;
}
const line = (erp, pid, qty, size, daysAgo = 5) =>
  pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, product_name, size_l, qty) VALUES ($1, $2, current_date - $3::int, $4, 'x', $5, $6)",
    [`${tag}-${erp}`, `${tag}-o-${erp}`, daysAgo, `${tag}-${pid}`, size, qty]
  );

test("stages from real sales; the API is management only; moves are remembered", async () => {
  const pot = await customer("potential", { level: 3 });
  const twoGroups = await customer("silver", { erp: "a" }); // silver needs 4 groups -> stage 2
  await line("a", 1, 10, "4L");
  await line("a", 2, 2, "1L");
  const share = await customer("bronze", { erp: "b", expected: 100 }); // 2 groups -> stage 3; 270 L in 90 days = 90 L / month of 100 -> stage 4
  await line("b", 1, 60, "4L");
  await line("b", 3, 30, "1L");
  await line("b", 2, 1, "4L", 200); // outside the 90-day window: not counted

  const res = await apiRequest("/api/funnel", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const byId = new Map(res.data.customers.map((c) => [c.id, c]));
  assert.deepEqual([byId.get(pot.id).stage, byId.get(pot.id).progress], [1, 75]);
  assert.deepEqual([byId.get(twoGroups.id).stage, byId.get(twoGroups.id).groups, byId.get(twoGroups.id).progress], [2, 2, 50]);
  assert.deepEqual([byId.get(share.id).stage, byId.get(share.id).groups, byId.get(share.id).litres_month, byId.get(share.id).share], [4, 2, 90, 90]);

  assert.equal((await apiRequest("/api/funnel", { cookie: repCookie })).status, 403, "a rep does not open the management funnel");

  // the job: first run records where everybody stands, a later change is logged as a move
  await recordFunnelMoves();
  await pool.query("UPDATE customers SET customer_tier = 'bronze', erp_customer_id = $2 WHERE id = $1", [pot.id, `${tag}-c`]);
  await recordFunnelMoves();
  const { rows } = await pool.query("SELECT from_stage, to_stage FROM customer_funnel_moves WHERE customer_id = $1", [pot.id]);
  assert.deepEqual(rows, [{ from_stage: 1, to_stage: 2 }]);
  const after = (await apiRequest("/api/funnel", { cookie: adminCookie })).data;
  assert.ok(after.moves.some((m) => m.customer_id === pot.id && m.from_stage === 1 && m.to_stage === 2));
  assert.ok(after.customers.find((c) => c.id === pot.id).since);
});

test("a line of a product not in the catalog is no product group; litres still count", async () => {
  const c = await customer("bronze", { erp: "d", expected: 1000 });
  await line("d", 1, 1, "4L");
  await pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, product_name, size_l, qty) VALUES ($1, 'x', current_date - 1, 'NOT-IN-CATALOG', 'x', '4L', 2)",
    [`${tag}-d`]
  );
  const row = (await apiRequest("/api/funnel", { cookie: adminCookie })).data.customers.find((x) => x.id === c.id);
  assert.deepEqual([row.groups, row.stage], [1, 2]);
  assert.equal(row.litres_month, 4, "12 L over 90 days = 4 L a month");
});

test("management writes a tiered customer's monthly need; bad values are refused; a rep is not allowed", async () => {
  const c = await customer("bronze", { erp: "e" });
  assert.equal((await apiRequest(`/api/funnel/customers/${c.id}/expected-volume`, { method: "PUT", cookie: adminCookie, body: { expected_volume_l: 250 } })).status, 200);
  assert.equal(Number((await pool.query("SELECT expected_volume_l FROM customers WHERE id = $1", [c.id])).rows[0].expected_volume_l), 250);
  assert.equal((await apiRequest(`/api/funnel/customers/${c.id}/expected-volume`, { method: "PUT", cookie: adminCookie, body: { expected_volume_l: -5 } })).status, 400);
  assert.equal((await apiRequest(`/api/funnel/customers/${c.id}/expected-volume`, { method: "PUT", cookie: repCookie, body: { expected_volume_l: 10 } })).status, 403);
});

test("the numbers have their own ranges; a rule change is not logged as customers moving", async () => {
  const put = (patch) => apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: adminCookie, body: patch });
  assert.equal((await put({ funnelGroupsGold: 8 })).status, 400, "only 7 product groups exist");
  assert.equal((await put({ funnelSharePct: 101 })).status, 400);
  assert.equal((await put({ funnelWindowDays: 3 })).status, 400);
  const gold = await customer("gold", { erp: "f" });
  await line("f", 1, 1, "4L");
  await line("f", 2, 1, "1L");
  await recordFunnelMoves();
  const before = (await pool.query("SELECT COUNT(*)::int AS n FROM customer_funnel_moves")).rows[0].n;
  try {
    assert.equal((await put({ funnelGroupsGold: 2 })).status, 200); // the gold customer now reaches stage 3 by the rule change alone
    await recordFunnelMoves();
    assert.equal((await pool.query("SELECT stage FROM customer_funnel_stage WHERE customer_id = $1", [gold.id])).rows[0].stage, 3);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM customer_funnel_moves")).rows[0].n, before, "no moves logged for a rule change");
  } finally {
    await put({ funnelGroupsGold: 6 });
    await recordFunnelMoves();
  }
});

test("Monday picks: shadow stores the steps without tasks; once a week; live also gives tasks; management only", async () => {
  const { runWeeklyPicks } = await import("../../src/team/vaghinak/nextSteps.js");
  const hi = await customer("potential", { level: 4 });
  await pool.query("DELETE FROM sales_step_picks WHERE week_start >= current_date - 7");
  const r = await apiRequest("/api/funnel/picks/run", { method: "POST", cookie: adminCookie });
  assert.equal(r.status, 200);
  const pick = (await pool.query("SELECT kind, task_id FROM sales_step_picks WHERE customer_id = $1", [hi.id])).rows[0];
  assert.deepEqual([pick?.kind, pick?.task_id], ["first_order", null], "shadow: a pick, no task");
  assert.equal((await runWeeklyPicks(new Date(), pool, { force: true, onlyRepIds: [rep.id] })).picked, 0, "once a week");
  const view = (await apiRequest("/api/funnel", { cookie: adminCookie })).data;
  assert.equal(view.customers.find((c) => c.id === hi.id).step.kind, "first_order");
  assert.ok(view.picks.some((p) => p.customer_id === hi.id));
  assert.equal(view.steps_mode, "shadow");
  assert.equal((await apiRequest("/api/funnel/picks/run", { method: "POST", cookie: repCookie })).status, 403);

  // live: the same picks become the rep's tasks
  await pool.query("DELETE FROM sales_step_picks WHERE week_start >= current_date - 7");
  await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: adminCookie, body: { salesStepsMode: "live" } });
  try {
    await runWeeklyPicks(new Date(), pool, { force: true, onlyRepIds: [rep.id] });
    const live = (await pool.query("SELECT p.task_id, t.assignee_id, t.auto_kind FROM sales_step_picks p JOIN tasks t ON t.id = p.task_id WHERE p.customer_id = $1", [hi.id])).rows[0];
    assert.deepEqual([live?.assignee_id, live?.auto_kind], [rep.id, "sales_step"]);
    // next week: a customer whose step task is still open is not picked again (fresh customers for the rep)
    await pool.query("UPDATE sales_step_picks SET week_start = week_start - 21 WHERE customer_id = $1", [hi.id]);
    await pool.query("DELETE FROM sales_step_picks WHERE week_start >= current_date - 7");
    await runWeeklyPicks(new Date(), pool, { force: true, onlyRepIds: [rep.id] });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM sales_step_picks WHERE customer_id = $1 AND week_start >= current_date - 7", [hi.id])).rows[0].n, 0);
  } finally {
    await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: adminCookie, body: { salesStepsMode: "shadow" } });
    await pool.query("DELETE FROM tasks WHERE auto_kind = 'sales_step' AND assignee_id = $1", [rep.id]);
    await pool.query("DELETE FROM sales_step_picks WHERE customer_id = ANY($1::int[])", [made]);
  }
});

test("the competitor comes from the last visit that recorded competitors, not from a later visit that only recorded our brands", async () => {
  const { computeNextSteps } = await import("../../src/team/vaghinak/nextSteps.js");
  const c = await customer("bronze", { erp: "cmp", expected: 1000 });
  await line("cmp", 1, 2, "4L");
  await line("cmp", 2, 2, "1L");
  const visit = (brand, daysAgo) =>
    pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, brand_status, "timestamp")
       VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], $3::jsonb, now() - $4::int * interval '1 day')`,
      [c.id, rep.id, JSON.stringify(brand), daysAgo]
    );
  await visit({ competitors: ["mobil"] }, 10);
  await visit({ castrol: ["available"] }, 2);
  try {
    const step = (await computeNextSteps()).find((s) => s.customer.id === c.id);
    assert.equal(step?.kind, "raise_share_competitor");
    assert.equal(step.params.brand, "mobil");
  } finally {
    await pool.query("DELETE FROM checkins WHERE customer_id = $1", [c.id]);
  }
});

test("first time seen: a potential customer counts its days on stage 1 from its creation, a buying one from now", async () => {
  const pot = await customer("potential", { level: 3 });
  const buyer = await customer("bronze", { erp: "since" });
  await line("since", 1, 1, "4L");
  await pool.query("UPDATE customers SET created_at = now() - interval '100 days' WHERE id = ANY($1::int[])", [[pot.id, buyer.id]]);
  await pool.query("DELETE FROM customer_funnel_stage WHERE customer_id = ANY($1::int[])", [[pot.id, buyer.id]]);
  await recordFunnelMoves();
  const { rows } = await pool.query(
    "SELECT customer_id, stage, floor(extract(epoch FROM now() - since) / 86400)::int AS days FROM customer_funnel_stage WHERE customer_id = ANY($1::int[])",
    [[pot.id, buyer.id]]
  );
  const of = new Map(rows.map((r) => [r.customer_id, r]));
  assert.deepEqual([of.get(pot.id)?.stage, of.get(pot.id)?.days], [1, 100]);
  assert.deepEqual([of.get(buyer.id)?.stage, of.get(buyer.id)?.days], [2, 0]);
  // later runs keep the date while the stage stays the same
  await recordFunnelMoves();
  assert.equal((await pool.query("SELECT floor(extract(epoch FROM now() - since) / 86400)::int AS d FROM customer_funnel_stage WHERE customer_id = $1", [pot.id])).rows[0].d, 100);
});

test("the customer card carries the funnel stage and since when (the card's stage chip)", async () => {
  const pot = await customer("potential", { level: 2 });
  await recordFunnelMoves();
  const r = await apiRequest(`/api/customers/${pot.id}`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.funnel_stage?.stage, 1);
  assert.ok(r.data.funnel_stage?.since);
});
