// Period buttons (owner, 2026-10-22): tapping the selected button shows the previous period (yesterday / last week / last month /
// last quarter / last year). The server side: every list and report that takes a period understands those keys, in Yerevan days.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, director, admin, repCookie, directorCookie, adminCookie, customer;
const DAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan')`;

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  admin = await createUser("admin");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  adminCookie = await loginAs(admin.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PP-${Date.now()}` });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const checkin = (daysAgo, interval = "10 hours") =>
  pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp)
     VALUES ($1, $2, 40.18, 44.51, 5, true, ${DAY} - interval '${daysAgo} days' + interval '${interval}') RETURNING id`,
    [customer.id, rep.id]
  );

test("Activity: today and yesterday are separate days (a check-in at 01:00 Yerevan belongs to its own day)", async () => {
  await checkin(0, "1 hour");
  const y = (await checkin(1, "23 hours")).rows[0].id;
  const ids = async (range) => (await apiRequest(`/api/checkins?range=${range}`, { cookie: repCookie })).data.rows.map((r) => r.id);
  const today = await ids("today");
  const yesterday = await ids("yesterday");
  assert.ok(yesterday.includes(y));
  assert.equal(today.includes(y), false);
  assert.equal(yesterday.length, 1);
  assert.ok(today.length >= 1);
  // the week and month keys keep working, and the previous ones return something well-formed
  for (const range of ["week", "last_week", "month", "last_month", "quarter", "last_quarter", "year", "last_year"]) {
    const r = await apiRequest(`/api/checkins?range=${range}`, { cookie: repCookie });
    assert.equal(r.status, 200, range);
    assert.ok(Array.isArray(r.data.rows), range);
  }
});

test("Reports: the previous periods are accepted and a period only counts its own days", async () => {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, created_by, status)
     VALUES ($1, 'x', 11000, ${DAY} - interval '1 day' + interval '12 hours', $2, 'Rep', $2, 'approved') RETURNING id`,
    [customer.id, rep.id]
  );
  const total = async (period) => {
    const r = await apiRequest(`/api/reports/payments?period=${period}&sales_manager_id=${rep.id}`, { cookie: adminCookie });
    assert.equal(r.status, 200, `${period}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  for (const period of ["today", "yesterday", "week", "last_week", "month", "last_month", "quarter", "last_quarter", "year", "last_year", "all"]) await total(period);
  const yesterday = JSON.stringify(await total("yesterday"));
  const today = JSON.stringify(await total("today"));
  assert.match(yesterday, /11000/);
  assert.doesNotMatch(today, /11000/);
  await pool.query("DELETE FROM payments WHERE id = $1", [rows[0].id]);
});

test("Progress by reps: yesterday and last month are periods too", async () => {
  for (const period of ["today", "yesterday", "week", "last_week", "month", "last_month"]) {
    const r = await apiRequest(`/api/dashboard/rep-progress?period=${period}`, { cookie: directorCookie });
    assert.equal(r.status, 200, period);
  }
  const yesterday = (await apiRequest("/api/dashboard/rep-progress?period=yesterday", { cookie: directorCookie })).data;
  const today = (await apiRequest("/api/dashboard/rep-progress?period=today", { cookie: directorCookie })).data;
  assert.notEqual(yesterday.from_day ?? yesterday.from, today.from_day ?? today.from);
});

test("Company dashboard: the sales leaderboard takes month / quarter / year and the previous month / quarter / year", async () => {
  for (const period of ["mtd", "last_month", "qtd", "last_quarter", "ytd", "last_year", undefined]) {
    const r = await apiRequest(`/api/sales-performance/${period ? `?period=${period}` : ""}`, { cookie: directorCookie });
    assert.equal(r.status, 200, String(period));
    assert.ok(Array.isArray(r.data), String(period));
  }
});

test("Products & liters report: This quarter / Last quarter are standard periods with their own comparison window", async () => {
  for (const period of ["this_quarter", "last_quarter"]) {
    const r = await apiRequest(`/api/volume-report?period=${period}`, { cookie: adminCookie });
    assert.equal(r.status, 200, `${period}: ${JSON.stringify(r.data).slice(0, 200)}`);
    assert.equal(r.data.period, period);
    assert.ok(r.data.from <= r.data.to);
  }
});
