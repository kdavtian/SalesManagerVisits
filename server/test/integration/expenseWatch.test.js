// Vaghinak's expense analysis (owner, 2026-10-25): findings from the Excel cashflow, field cash expenses matched against it, the weekly report.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { runExpenseWatch, expenseSummary, recommendationsFor } from "../../src/expenseWatch.js";

const CAT = `ItestExp${Date.now()}`;
const NOW = new Date("2026-10-20T08:00:00Z"); // Tuesday 12:00 in Yerevan, day 20 of the month
let admin, rep, adminCookie, repCookie, categoryId;
const entryIds = [];

async function entry(date, amount, { info = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, info, origin) VALUES ($1, $2, $2, $3, $4, 'manual') RETURNING id`,
    [date, -amount, categoryId, info]
  );
  entryIds.push(rows[0].id);
  return rows[0].id;
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  categoryId = (await pool.query("INSERT INTO cash_categories (name, kind, sort_order) VALUES ($1, 'expense', 999) RETURNING id", [CAT])).rows[0].id;
  // three quiet months at 400,000 (Jul, Aug, Sep) ...
  for (const d of ["2026-07-10", "2026-08-10", "2026-09-10"]) await entry(d, 400000, { info: "regular" });
  // ... and a loud October so far: 1,500,000 in 19 days (on course for about 2.3M)
  await entry("2026-10-02", 600000, { info: "tyres" });
  await entry("2026-10-12", 300000, { info: "repair" });
  await entry("2026-10-12", 300000, { info: "repair" }); // the same amount twice on one day
  await entry("2026-10-16", 300000); // no description
});
test.after(async () => {
  await pool.query("DELETE FROM expense_alerts");
  await pool.query("DELETE FROM expense_reports");
  await pool.query("DELETE FROM cash_expenses WHERE user_id = $1", [rep.id]);
  await pool.query("DELETE FROM cash_entries WHERE id = ANY($1)", [entryIds]);
  await pool.query("DELETE FROM cash_categories WHERE id = $1", [categoryId]);
  await cleanupAll();
  await stopTestServer();
});

const alerts = async (kind) => (await pool.query("SELECT * FROM expense_alerts WHERE kind = $1 AND category = $2", [kind, CAT])).rows;

test("a category on course to spend far more than its 3-month average is a finding, with a recommendation", async () => {
  const s = await expenseSummary(NOW);
  const c = s.categories.find((x) => x.name === CAT);
  assert.equal(c.avg3, 400000);
  assert.equal(c.mtd, 1500000);
  assert.ok(c.projected > 2000000);
  assert.ok(c.change_pct >= 400);
  const rec = recommendationsFor(s).find((r) => r.code === "category_up" && r.category === CAT);
  assert.ok(rec);
  await runExpenseWatch(NOW);
  const spike = await alerts("category_spike");
  assert.equal(spike.length, 1);
  assert.equal(spike[0].status, "open");
  assert.equal(spike[0].severity, 3);
});

test("a duplicate entry and a big entry without a description are findings", async () => {
  await runExpenseWatch(NOW);
  assert.equal((await alerts("duplicate_entry")).length, 1);
  const noDesc = await alerts("no_description");
  assert.equal(noDesc.length, 1);
  assert.equal(Number(noDesc[0].amount_amd), 300000);
  // 600,000 on 2 October is older than the 7-day window of "big entry"; nothing this week is 3x the usual
  assert.equal((await alerts("big_entry")).length, 0);
});

test("a field cash expense recorded in the app must show up in the Excel within 5 days", async () => {
  const { rows } = await pool.query(
    "INSERT INTO cash_expenses (user_id, amount_amd, purpose, created_at) VALUES ($1, 45000, 'fuel', now() - interval '8 days') RETURNING id",
    [rep.id]
  );
  await runExpenseWatch(NOW);
  const miss = (await pool.query("SELECT * FROM expense_alerts WHERE dedupe_key = $1", [`ace:${rows[0].id}`])).rows[0];
  assert.equal(miss.kind, "app_expense_not_in_excel");
  assert.equal(miss.status, "open");
  // the list of the rep's own expenses says it too
  const list = await apiRequest("/api/cash-expenses", { cookie: repCookie });
  const mine = list.data.rows.find((r) => r.id === rows[0].id);
  assert.equal(mine.in_excel, false);
  assert.ok(mine.days_old >= 8);
  // the Excel gets the row (same amount, 7 days ago) -> the finding closes itself
  const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  await entry(day, 45000, { info: "fuel" });
  await runExpenseWatch(NOW);
  assert.equal((await pool.query("SELECT status FROM expense_alerts WHERE dedupe_key = $1", [`ace:${rows[0].id}`])).rows[0].status, "auto_resolved");
  assert.equal((await apiRequest("/api/cash-expenses", { cookie: repCookie })).data.rows.find((r) => r.id === rows[0].id).in_excel, true);
});

test("Monday 09:00 and later: one weekly report per week, management is told once", async () => {
  const monday = new Date("2026-10-26T06:00:00Z"); // 10:00 in Yerevan
  await pool.query("DELETE FROM expense_reports");
  await pool.query("DELETE FROM notifications WHERE user_id = $1", [admin.id]);
  const first = await runExpenseWatch(monday);
  assert.equal(first.weekly, true);
  const second = await runExpenseWatch(monday);
  assert.equal(second.weekly, false);
  const { rows } = await pool.query("SELECT * FROM expense_reports");
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].week_start).slice(0, 10) === "2026-10-26" || rows[0].summary.week_start === "2026-10-19", true);
  const notes = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'expense_alert' AND title = 'Շաբաթվա ծախսերը'", [admin.id]);
  assert.equal(notes.rows.length, 1);
  // before 09:00 nothing is sent
  await pool.query("DELETE FROM expense_reports");
  assert.equal((await runExpenseWatch(new Date("2026-10-26T04:30:00Z"))).weekly, false);
});

test("only management sees the expense page; a finding can be dismissed", async () => {
  assert.equal((await apiRequest("/api/expenses", { cookie: repCookie })).status, 403);
  await runExpenseWatch(NOW);
  const r = await apiRequest("/api/expenses", { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.data.months.length === 7);
  assert.ok(Array.isArray(r.data.categories));
  const mine = r.data.alerts.find((a) => a.category === CAT && a.kind === "category_spike");
  assert.ok(mine);
  assert.equal((await apiRequest(`/api/expenses/alerts/${mine.id}/dismiss`, { method: "POST", cookie: adminCookie, body: {} })).status, 200);
  assert.equal((await apiRequest(`/api/expenses/alerts/${mine.id}/dismiss`, { method: "POST", cookie: adminCookie, body: {} })).status, 404);
});
