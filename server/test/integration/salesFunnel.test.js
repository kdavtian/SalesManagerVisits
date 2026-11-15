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
  assert.ok(after.moves.some((m) => m.from_stage === 1 && m.to_stage === 2 && m.n >= 1));
  assert.ok(after.customers.find((c) => c.id === pot.id).since);
});
