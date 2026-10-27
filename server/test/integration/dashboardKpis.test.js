// The desktop Home KPI tiles (owner, 2026-10-25): management-only, numbers match the data behind them.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, trackCheckin, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { computeKpis } from "../../src/dashboardKpis.js";

const ERP = `KPI-${Date.now()}`;
let admin, rep, adminCookie, repCookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP]);
  await cleanupAll();
  await stopTestServer();
});

test("only management roles can read the KPIs", async () => {
  assert.equal((await apiRequest("/api/dashboard/kpis", { cookie: repCookie })).status, 403);
  const ok = await apiRequest("/api/dashboard/kpis", { cookie: adminCookie });
  assert.equal(ok.status, 200);
  for (const k of ["sales", "debt", "payments", "orders", "tasks"]) assert.ok(ok.data[k], k);
});

test("sales of the month and of the same days of last month come from the workbook order lines", async () => {
  const now = new Date("2026-10-20T08:00:00Z");
  const before = await computeKpis(now);
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES
       ($1, 'K1', '2026-10-05', 700000), ($1, 'K2', '2026-10-19', 300000),
       ($1, 'K3', '2026-09-10', 400000), ($1, 'K4', '2026-09-28', 900000)`,
    [ERP]
  );
  const k = await computeKpis(now);
  // this month so far / the first 20 days of September / all of September
  assert.equal(k.sales.mtd_amd - before.sales.mtd_amd, 1000000);
  assert.equal(k.sales.prev_mtd_amd - before.sales.prev_mtd_amd, 400000);
  assert.equal(k.sales.prev_month_amd - before.sales.prev_month_amd, 1300000);
});

// Desktop Home "Today" (step 7): management only; each active field rep with plan vs visits today, and today's visits for the map.
test("Today: management only, the rep's visit today is counted and mapped", async () => {
  assert.equal((await apiRequest("/api/dashboard/today", { cookie: repCookie })).status, 403);
  const shop = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, lat: 40.2, lng: 44.5 });
  const { rows } = await pool.query(
    "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.2, 44.5, 3, true) RETURNING id",
    [shop.id, rep.id]
  );
  trackCheckin(rows[0].id);
  const res = await apiRequest("/api/dashboard/today", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const mine = res.data.reps.find((r) => r.user_id === rep.id);
  assert.equal(mine.visited, 1);
  assert.equal(mine.planned, 0);
  assert.ok(mine.first_at);
  assert.ok(!res.data.reps.some((r) => r.user_id === admin.id), "only field reps are listed");
  const v = res.data.visits.find((x) => x.customer_id === shop.id);
  assert.equal(v.user_id, rep.id);
  assert.equal(Number(v.lat), 40.2);
});
