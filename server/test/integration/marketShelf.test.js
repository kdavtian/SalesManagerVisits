// Reports > Shelf share (GET /api/market/shelf): fresh shelf records of real check-ins, filters, management only. Made-up names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const region = `zz_region_${Date.now().toString(36)}`;
let rep, ceo, cookies = {}, a, b;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  ceo = await createUser("ceo");
  for (const [k, u] of Object.entries({ rep, ceo })) cookies[k] = await loginAs(u.email);
  a = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  b = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  await pool.query("UPDATE customers SET region = $1, expected_volume_l = 300 WHERE id = $2", [region, a.id]);
  await pool.query("UPDATE customers SET region = $1, expected_volume_l = 100 WHERE id = $2", [region, b.id]);
  const visit = (c, status, days) =>
    pool.query(
      `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, brand_status)
       VALUES ($1, $2, now() - ($3 || ' days')::interval, 40.18, 44.51, 5, true, $4)`,
      [c.id, rep.id, String(days), JSON.stringify(status)]
    );
  await visit(a, { castrol: ["available"], competitors: ["motul"] }, 2);
  await visit(b, { castrol: ["fake"], competitors: ["motul"] }, 3);
  await visit(b, { castrol: ["available"] }, 90); // too old
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("region filter: numeric and weighted Castrol share, the fake spot; a rep may not open it", async () => {
  const r = await apiRequest(`/api/market/shelf?region=${region}`, { cookie: cookies.ceo });
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.shops, 2);
  const c = r.data.totals.brands.find((x) => x.key === "castrol");
  assert.deepEqual([c.numeric_pct, c.weighted_pct], [50, 75]);
  assert.equal(r.data.totals.brands.find((x) => x.key === "motul").numeric_pct, 100);
  assert.deepEqual(r.data.flagged.map((f) => [f.customer_id, f.fake]), [[b.id, true]]);
  assert.ok(r.data.regions.includes(region));
  assert.equal((await apiRequest("/api/market/shelf", { cookie: cookies.rep })).status, 403);
});
