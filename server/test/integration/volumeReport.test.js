// Products & liters report (server/src/reports/volumeReport.js, GET /api/volume-report): periods, filters (product text,
// brand/line/grade/size, channel of the LINE, region), comparison, breakdowns, scope. Liters only, no money.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";
import { addDays, standardPeriods, resolveWindows } from "../../src/reports/volumeReport.js";

const stamp = Date.now();
const today = yerevanToday();
const erpIds = [];
let director, rep, otherRep, accountant, cookies;
let magnatec, royal, edge, c1, c2, c3;

const line = (erp, orderId, date, product, qty, revenue, salesRep = null) =>
  pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, sales_rep)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, 1, $9, $10)`,
    [erp, `VR-${stamp}-${orderId}`, date, product.erp_product_id, product.brand, product.name, product.size, qty, revenue, salesRep]
  );

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  otherRep = await createUser("sales_manager");
  accountant = await createUser("accountant");
  cookies = { director: await loginAs(director.email), rep: await loginAs(rep.email), accountant: await loginAs(accountant.email) };
  const mk = async (name, brand, family, size, cost) => {
    const p = await createProduct({ name, unit: `${size}L` });
    const erp = `VR-${stamp}-${name.replace(/\W/g, "")}-${size}`;
    await pool.query("UPDATE products SET brand = $2, family = $3, erp_product_id = $4, landing_cost_amd = $5 WHERE id = $1", [p.id, brand, family, erp, cost]);
    return { ...p, brand, family, size: String(size), erp_product_id: erp };
  };
  magnatec = await mk("Magnatec 5W-30 C3", "Castrol", "Magnatec", 4, 20000);
  royal = await mk("Royal 0W-8", "Royal", "Royal", 1, 5000);
  edge = await mk("Edge 5W-40", "Castrol", "Edge", 208, 400000);
  const mkC = async (suffix, manager, region, subregion, channel) => {
    const erp = `VR-${stamp}-${suffix}`;
    erpIds.push(erp);
    const c = await createCustomer({ created_by: director.id, assigned_manager_id: manager.id, erp_customer_id: erp, sales_channel: channel });
    await pool.query("UPDATE customers SET region = $2, subregion = $3 WHERE id = $1", [c.id, region, subregion]);
    return { ...c, erp };
  };
  c1 = await mkC("a", rep, "Yerevan", "Ajapnyak", "SM YVN");
  c2 = await mkC("b", rep, "Shirak", null, "SM Shirak");
  c3 = await mkC("c", otherRep, "Yerevan", "Davtashen", "CVO");
  // today: c1 5 x 4L Magnatec (20 L, 100,000 AMD, line sold by SM YVN); c2 2 x 1L Royal sold by CVO
  await line(c1.erp, 1, today, magnatec, 5, 100000, "SM YVN");
  await line(c2.erp, 2, today, royal, 2, 12000, "CVO");
  // yesterday: c3 1 x 208 L Edge (customer channel CVO, line has no sales_rep yet)
  await line(c3.erp, 3, addDays(today, -1), edge, 1, 600000, null);
  // same day last year and last month, to test windows
  await line(c1.erp, 4, addDays(today, -400), magnatec, 10, 200000, "SM YVN");
  // internal stock account: never a sale
  await line("10000", 5, today, magnatec, 100, 0, "SM YVN");
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE order_id LIKE $1", [`VR-${stamp}-%`]);
  await cleanupAll();
  await stopTestServer();
});

const get = (qs, who = "director") => apiRequest(`/api/volume-report?${qs}`, { cookie: cookies[who] });

test("date helpers: standard periods and the comparison windows", () => {
  const p = Object.fromEntries(standardPeriods("2026-10-13").map((x) => [x.key, x])); // a Tuesday
  assert.deepEqual([p.this_week.from, p.this_week.to], ["2026-10-12", "2026-10-13"]);
  assert.deepEqual([p.last_week.from, p.last_week.to], ["2026-10-05", "2026-10-11"]);
  assert.deepEqual([p.this_month.prev.from, p.this_month.prev.to], ["2026-09-01", "2026-09-13"]);
  assert.deepEqual([p.last_month.from, p.last_month.to], ["2026-09-01", "2026-09-30"]);
  assert.deepEqual([p.ytd.prev.from, p.ytd.prev.to], ["2025-01-01", "2025-10-13"]);
  assert.deepEqual([p.last_year.from, p.last_year.to], ["2025-01-01", "2025-12-31"]);
  assert.deepEqual([p.last_12m.from, p.last_12m.to], ["2025-10-14", "2026-10-13"]);
  const custom = resolveWindows({ from: "2026-10-01", to: "2026-10-10", compare: "prev" }, "2026-10-13");
  assert.deepEqual(custom.prev, { from: "2026-09-21", to: "2026-09-30" });
  assert.deepEqual(resolveWindows({ period: "today", compare: "yoy" }, "2028-02-29").prev, { from: "2027-02-28", to: "2027-02-28" });
});

test("today's liters: size x qty, internal stock account excluded, ERP lines only", async () => {
  const res = await get("period=today&compare=none");
  assert.equal(res.status, 200, JSON.stringify(res.data).slice(0, 300));
  assert.equal(res.data.period, "today");
  // our 2 lines only count if nothing else wrote today's lines in parallel; assert the parts we control via filters
  const mine = await get(`period=today&compare=none&cq=VR-${stamp}`);
  assert.equal(mine.data.totals.liters, 22); // 5 x 4 + 2 x 1; the 100 x 4 L of customer 10000 is not a sale
  assert.equal(mine.data.totals.orders, 2);
  assert.equal(mine.data.totals.customers, 2);
  // liters only: no money figures leave this report
  for (const k of ["revenue", "cost", "avg_price_per_liter", "revenue_costed"]) assert.equal(mine.data.totals[k], undefined);
});

test("filters: product text ignoring punctuation, brand, line, grade, size, channel of the line, region", async () => {
  const base = `compare=none&period=this_month&cq=VR-${stamp}`;
  const liters = async (extra) => (await get(`${base}&${extra}`)).data.totals.liters;
  assert.equal(await liters("q=magnatec 5w30 c3"), 20);
  assert.equal(await liters("q=royal 0w8"), 2);
  assert.equal(await liters("brands=Castrol"), 20 + 208);
  assert.equal(await liters("families=Magnatec"), 20);
  assert.equal(await liters("grades=0W-8"), 2);
  assert.equal(await liters("grades=5W-30"), 20);
  assert.equal(await liters("sizes=208"), 208);
  assert.equal(await liters("channels=SM YVN"), 20, "channel = the LINE's selling channel");
  assert.equal(await liters("channels=CVO"), 2 + 208, "line channel CVO, or the customer's channel when the line has none");
  assert.equal(await liters("region_sub=Yerevan::Ajapnyak"), 20);
  assert.equal(await liters("region_sub=Yerevan::Ajapnyak,Shirak::__none__"), 22);
  assert.equal(await liters("q=magnatec&channels=CVO"), 0);
  // the share base is every liter of the period (customer filter aside, which is a filter too)
  const all = await get("period=today&compare=none&q=magnatec");
  assert.ok(all.data.totals.all_liters >= all.data.totals.liters);
});

test("comparison, periods card, breakdowns and trend", async () => {
  const res = await get(`period=this_month&compare=prev&group_by=family&cq=VR-${stamp}`);
  assert.ok(res.data.prev_totals);
  assert.deepEqual(Object.keys(res.data.periods.reduce((a, p) => ({ ...a, [p.key]: 1 }), {})), ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_quarter", "last_quarter", "ytd", "last_year", "last_12m"]);
  const todayRow = res.data.periods.find((p) => p.key === "today");
  assert.equal(todayRow.liters, 22);
  const ytd = res.data.periods.find((p) => p.key === "ytd");
  assert.ok(ytd.liters >= 22);
  const fam = Object.fromEntries(res.data.rows.map((r) => [r.key, r.liters]));
  assert.equal(fam.Magnatec, 20);
  assert.equal(fam.Royal, 2);
  const byProduct = await get(`period=today&compare=none&group_by=product&cq=VR-${stamp}`);
  assert.equal(byProduct.data.rows[0].liters, 20);
  assert.match(byProduct.data.rows[0].label, /Magnatec 5W-30 C3 4L/);
  const byDay = await get(`from=${addDays(today, -2)}&to=${today}&compare=none&group_by=day&cq=VR-${stamp}`);
  assert.deepEqual(byDay.data.rows.map((r) => r.liters), [208, 22]);
  assert.equal(byDay.data.trend.bucket, "day");
  // trend is zero-filled per day and the comparison window is laid out the same way
  assert.deepEqual(byDay.data.trend.rows.map((r) => r.key), [addDays(today, -2), addDays(today, -1), today]);
  assert.deepEqual(byDay.data.trend.rows.map((r) => r.liters), [0, 208, 22]);
  assert.equal(byDay.data.trend.prev_rows, null);
  assert.equal(res.data.trend.prev_rows.length, res.data.prev_totals ? res.data.trend.prev_rows.length : 0);
  // month by month this year and last year (zero-filled, from January of last year to this month)
  assert.equal(res.data.monthly.rows[0].key, `${res.data.monthly.year - 1}-01`);
  assert.equal(res.data.monthly.rows.at(-1).key, today.slice(0, 7));
  assert.ok(res.data.monthly.rows.find((r) => r.key === today.slice(0, 7)).liters >= 22);
  const lastYear = await get(`from=${addDays(today, -401)}&to=${addDays(today, -399)}&compare=none&cq=VR-${stamp}`);
  assert.equal(lastYear.data.totals.liters, 40);
  // facets list the options that exist, with liters
  assert.ok(res.data.facets.brand.some((b) => b.key === "Castrol"));
  assert.ok(res.data.facets.grade.some((g) => g.key === "5W-30"));
  assert.ok(res.data.facets.product.some((p) => p.label.includes("Royal 0W-8")));
});

test("sales manager sees only their own customers; others refused", async () => {
  const mineRep = await get(`period=today&compare=none&group_by=product`, "rep");
  assert.equal(mineRep.status, 200);
  assert.ok(mineRep.data.totals.liters >= 22);
  const names = mineRep.data.rows.map((r) => r.label).join("|");
  assert.ok(!/Edge/.test(names), "the other rep's customers are not in the numbers");
  const warehouse = await createUser("warehouse_manager");
  assert.equal((await apiRequest("/api/volume-report", { cookie: await loginAs(warehouse.email) })).status, 403);
});
