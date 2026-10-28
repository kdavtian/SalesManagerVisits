// Home "progress by reps": per-rep visits / check-ins / payments / orders / hours worked (rounded UP to 0.25 h).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { roundUpQuarterHours } from "../../src/field/repProgress.js";

let rep, director, repCookie, directorCookie, c1, c2, product;
const DAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan')`;

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager", { name: "Rep Progress Test" });
  director = await createUser("sales_director");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  c1 = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `RP-1-${Date.now()}` });
  c2 = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `RP-2-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("rounds up to the next quarter hour; a single check-in is 0", () => {
  assert.equal(roundUpQuarterHours(Date.parse("2026-01-05T11:30:00+04:00"), Date.parse("2026-01-05T17:44:00+04:00")), 6.25);
  assert.equal(roundUpQuarterHours(Date.parse("2026-01-05T09:00:00+04:00"), Date.parse("2026-01-05T11:00:00+04:00")), 2);
  assert.equal(roundUpQuarterHours(Date.parse("2026-01-05T09:00:00+04:00"), Date.parse("2026-01-05T09:00:01+04:00")), 0.25);
  assert.equal(roundUpQuarterHours(5, 5), 0);
});

test("only management reads it; numbers add up per rep", async () => {
  assert.equal((await apiRequest("/api/dashboard/rep-progress", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/dashboard/rep-progress?period=year", { cookie: directorCookie })).status, 400);

  // Today (Yerevan): 11:30 and 17:44 at customer 1, 12:00 at customer 2 -> 3 check-ins, 2 visits, 6.25 h.
  for (const [cust, at] of [[c1, "11 hours 30 minutes"], [c1, "17 hours 44 minutes"], [c2, "12 hours"]]) {
    await pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp) VALUES ($1, $2, 40.18, 44.51, 5, true, ${DAY_START} + interval '${at}')`,
      [cust.id, rep.id]
    );
  }
  const pay = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, created_by, status)
     VALUES ($1, 'x', 30000, ${DAY_START} + interval '13 hours', $2, 'Rep', $2, 'approved') RETURNING id`,
    [c1.id, rep.id]
  );
  trackPayment(pay.rows[0].id);
  const created = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: c1.id, payment_method: "cash", items: [{ product_id: product.id, quantity: 3 }] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  trackOrder(created.data.id);

  const { status, data } = await apiRequest("/api/dashboard/rep-progress?period=today", { cookie: directorCookie });
  assert.equal(status, 200);
  const row = data.reps.find((r) => r.user_id === rep.id);
  assert.equal(row.checkins, 3);
  assert.equal(row.visits, 2);
  assert.equal(row.customers_visited, 2);
  assert.equal(row.payments_count, 1);
  assert.equal(row.payments_amd, 30000);
  assert.equal(row.payments_pct_of_visits, 50);
  assert.equal(row.orders_count, 1);
  assert.equal(row.orders_pct_of_visits, 50);
  assert.equal(row.liters, 12);
  assert.equal(row.hours, 6.25);
  assert.equal(row.days_worked, 1);
  assert.equal(data.days.length, 1);
  assert.equal(row.hours_by_day[data.today], 6.25);

  // The week contains today too; last week does not.
  const week = (await apiRequest("/api/dashboard/rep-progress?period=week", { cookie: directorCookie })).data.reps.find((r) => r.user_id === rep.id);
  assert.equal(week.checkins, 3);
  const last = (await apiRequest("/api/dashboard/rep-progress?period=last_week", { cookie: directorCookie })).data.reps.find((r) => r.user_id === rep.id);
  assert.equal(last.checkins, 0);
  assert.equal(last.payments_pct_of_visits, null);
});
