// Reports > Market data quality (reports/market/marketPrices.js, GET /api/market/quality): per rep visits, shelf share, price share,
// flagged entries, score; the flagged entries list; management only. Made-up names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let repA, repB, ceo, cookies = {}, shop1, shop2, shop3;
const checkinIds = [];
async function visit(rep, shop, { shelf = false, daysAgo = 1 } = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, brand_status)
     VALUES ($1, $2, now() - ($3 || ' days')::interval, 40.18, 44.51, 5, true, $4) RETURNING id`,
    [shop.id, rep.id, String(daysAgo), shelf ? JSON.stringify({ castrol: ["available"] }) : null]
  );
  checkinIds.push(r.id);
  return r.id;
}
const price = (checkinId, rep, shop, o) =>
  pool.query(
    `INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd, recorded_at)
     VALUES ($1, $2, $3, 'motul', 'pcmo_10w40', $4, 'L', $5, $6, now() - ($7 || ' days')::interval)`,
    [checkinId, shop.id, rep.id, o.volume ?? 4, o.w ?? null, o.r ?? null, String(o.daysAgo ?? 1)]
  );

test.before(async () => {
  await startTestServer();
  repA = await createUser("sales_manager");
  repB = await createUser("sales_manager");
  ceo = await createUser("ceo");
  for (const [k, u] of Object.entries({ repA, ceo })) cookies[k] = await loginAs(u.email);
  shop1 = await createCustomer({ created_by: repA.id, assigned_manager_id: repA.id, lat: 40.18, lng: 44.51 });
  shop2 = await createCustomer({ created_by: repA.id, assigned_manager_id: repA.id, lat: 40.18, lng: 44.51 });
  shop3 = await createCustomer({ created_by: repB.id, assigned_manager_id: repB.id, lat: 40.18, lng: 44.51 });
  // repA: 4 visits, 2 with the shelf, 2 with prices (one of them retail < wholesale)
  const a1 = await visit(repA, shop1, { shelf: true });
  const a2 = await visit(repA, shop2, { shelf: true });
  await visit(repA, shop1);
  await visit(repA, shop2, { daysAgo: 60 }); // outside 30 days
  await price(a1, repA, shop1, { w: 20000, r: 24000 });
  await price(a2, repA, shop2, { w: 21000, r: 19000 });
  // repB: 2 visits, both shelf, prices clean
  const b1 = await visit(repB, shop3, { shelf: true });
  await visit(repB, shop3, { shelf: true, daysAgo: 2 });
  await price(b1, repB, shop3, { w: 20500, r: 25000 });
});
test.after(async () => {
  await pool.query("DELETE FROM checkins WHERE id = ANY($1::int[])", [checkinIds]);
  await cleanupAll();
  await stopTestServer();
});

test("per rep: visits, shelf, prices, flagged and score; weakest first; flagged list with per-litre prices", async () => {
  const r = await apiRequest("/api/market/quality?days=30", { cookie: cookies.ceo });
  assert.equal(r.status, 200);
  const a = r.data.reps.find((x) => x.user_id === repA.id);
  const b = r.data.reps.find((x) => x.user_id === repB.id);
  assert.deepEqual(
    { visits: a.visits, shelf: a.shelf_visits, prices: a.price_visits, entries: a.price_entries, flagged: a.flagged_entries },
    { visits: 3, shelf: 2, prices: 2, entries: 2, flagged: 1 }
  );
  // 60 * 2/3 + 40 * 2/3 * (1 - 1/2) = 53
  assert.equal(a.score, 53);
  // 60 * 1 + 40 * 1/2 = 80
  assert.equal(b.score, 80);
  assert.ok(r.data.reps.indexOf(a) < r.data.reps.indexOf(b), "weakest first");
  const f = r.data.flagged.find((x) => x.customer_id === shop2.id);
  assert.deepEqual(f.flags, ["retail_below_wholesale"]);
  assert.equal(f.wholesale_per_unit, 5250);
  assert.equal(f.retail_per_unit, 4750);
  assert.ok(r.data.meta.shops >= 3 && r.data.meta.latest_at);
  // 90 days: repA's old visit counts
  const r90 = await apiRequest("/api/market/quality?days=90", { cookie: cookies.ceo });
  assert.equal(r90.data.reps.find((x) => x.user_id === repA.id).visits, 4);
});

test("a sales manager may not open it", async () => {
  assert.equal((await apiRequest("/api/market/quality", { cookie: cookies.repA })).status, 403);
});
