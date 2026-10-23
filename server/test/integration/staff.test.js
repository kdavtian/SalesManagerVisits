// Staff module (owner, 2026-10-23): payroll maths, the visit rule, day marks, access by hierarchy, salary payments from Cashflow.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { computeMonthPay, monthBounds, parseSalaryInfo, normalizeStaffSettings } from "../../src/payroll.js";

const REP = { fixed_salary_amd: 200000, visit_based: true, min_visit_pct: null, paid_dayoffs_per_month: 0, commission_basis: "none", commission_pct: 0 };
// October 2026: 31 days, 4 Sundays (4, 11, 18, 25) -> 27 working days (the owner's example: 200,000 / 27 = 7,407)
const OCT = "2026-10";

test("month bounds, salary info parsing, settings clamp", () => {
  assert.equal(monthBounds(OCT).days.length, 31);
  assert.equal(monthBounds("2026-13"), null);
  assert.deepEqual(parseSalaryInfo("SM YVN 2026 OCT"), { key: "sm yvn", month: "2026-10" });
  assert.deepEqual(parseSalaryInfo("Sales Manager B2B 2026 Jan"), { key: "sales manager b2b", month: "2026-01" });
  assert.equal(parseSalaryInfo("Зарплата за октябрь"), null);
  assert.equal(normalizeStaffSettings({ min_visit_pct: 500 }).min_visit_pct, 100);
  assert.equal(normalizeStaffSettings(null).min_visit_pct, 75);
});

test("daily rate = fixed / working days; the 75 % rule pays or withholds a day", () => {
  const visits = new Map([["2026-10-01", { planned: 8, done: 6 }], ["2026-10-02", { planned: 8, done: 5 }], ["2026-10-03", { planned: 4, done: 3 }]]);
  const pay = computeMonthPay(REP, OCT, { today: "2026-10-03", holidays: new Set(), visits, defaultMinPct: 75 });
  assert.equal(pay.working_days, 27);
  assert.equal(pay.daily_rate, 7407);
  // 6/8 = 75 % pays, 5/8 = 62 % does not, 3/4 = 75 % pays
  assert.equal(pay.paid_days, 2);
  assert.equal(pay.day_pay, Math.round((200000 / 27) * 2));
  assert.equal(pay.days.find((d) => d.date === "2026-10-02").state, "unpaid");
  // the CEO lowers the threshold -> the 62 % day pays
  assert.equal(computeMonthPay(REP, OCT, { today: "2026-10-03", visits, defaultMinPct: 60 }).paid_days, 3);
  // a person's own threshold beats the company default
  assert.equal(computeMonthPay({ ...REP, min_visit_pct: 50 }, OCT, { today: "2026-10-03", visits, defaultMinPct: 90 }).paid_days, 3);
});

test("a boss can mark a day completed / day off / unpaid; holidays shrink the basis; no plan = paid automatically", () => {
  const visits = new Map([["2026-10-01", { planned: 3, done: 2 }]]); // 67 % -> unpaid by rule
  const marks = new Map([["2026-10-01", "completed"], ["2026-10-02", "dayoff"], ["2026-10-03", "dayoff"], ["2026-10-05", "unpaid"]]);
  const pay = computeMonthPay({ ...REP, paid_dayoffs_per_month: 1 }, OCT, { today: "2026-10-06", holidays: new Set(["2026-10-07"]), visits, marks });
  assert.equal(pay.working_days, 26, "a company holiday is not a working day");
  const st = (d) => pay.days.find((x) => x.date === d).state;
  assert.equal(st("2026-10-01"), "paid");
  assert.equal(st("2026-10-02"), "dayoff_paid");
  assert.equal(st("2026-10-03"), "dayoff_unpaid", "over the paid allowance");
  assert.equal(st("2026-10-04"), "off", "Sunday");
  assert.equal(st("2026-10-05"), "unpaid");
  assert.equal(st("2026-10-06"), "paid", "no approved plan: paid automatically");
  assert.equal(st("2026-10-02"), "dayoff_paid");
  assert.equal(st("2026-10-07"), "off");
  assert.equal(st("2026-10-08"), "future");
  assert.equal(pay.paid_days, 3);
  const open = computeMonthPay(REP, OCT, { today: "2026-10-09", holidays: new Set(), visits: new Map([["2026-10-09", { planned: 4, done: 1 }]]) });
  assert.equal(open.days.find((x) => x.date === "2026-10-09").state, "future", "today with a plan below the % stays open");
});

test("people who are not visit-based are paid every working day; commission, premiums, bonuses and deductions add up; balance = total - paid", () => {
  const office = { ...REP, visit_based: false, fixed_salary_amd: 270000, commission_basis: "collected", commission_pct: 2 };
  const pay = computeMonthPay(office, OCT, {
    today: "2026-10-31", holidays: new Set(), commissionBase: 5000000,
    items: [{ kind: "premium", amount_amd: 20000 }, { kind: "bonus", amount_amd: 30000 }, { kind: "deduction", amount_amd: 5000 }], paid: 300000,
  });
  assert.equal(pay.paid_days, 27);
  assert.equal(pay.day_pay, 270000);
  assert.equal(pay.commission.amount, 100000);
  assert.equal(pay.total, 270000 + 100000 + 20000 + 30000 - 5000);
  assert.equal(pay.balance, pay.total - 300000);
  // start / end dates keep days outside the employment out
  const joined = computeMonthPay({ ...office, start_date: "2026-10-16" }, OCT, { today: "2026-10-31" });
  assert.ok(joined.paid_days < 27 && joined.days[0].state === "outside");
});

// ---- through the API ---------------------------------------------------------------------------------------------------------------------
let admin, accountant, director, repUser, repUser2, stranger, cookies = {}, ids = {};
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  accountant = await createUser("accountant");
  director = await createUser("sales_director");
  repUser = await createUser("sales_manager");
  repUser2 = await createUser("sales_manager");
  stranger = await createUser("delivery_manager");
  for (const [k, u] of Object.entries({ admin, accountant, director, rep: repUser, rep2: repUser2, stranger })) cookies[k] = await loginAs(u.email);
});
test.after(async () => {
  await pool.query("DELETE FROM staff_members WHERE position LIKE 'ITest%'");
  await pool.query("DELETE FROM cash_entries WHERE info LIKE 'ITest Pos%'");
  await pool.query("UPDATE app_settings SET staff_settings = NULL WHERE id = 1");
  await cleanupAll();
  await stopTestServer();
});

const api = (who, path, method = "GET", body) => apiRequest(`/api/staff${path}`, { method, cookie: cookies[who], body });

test("only admin / CEO / accountant manage people; the structure refuses loops", async () => {
  const mk = async (body) => {
    const r = await api("admin", "/people", "POST", body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id;
  };
  ids.boss = await mk({ name: "ITest Director", position: "ITest Director", kind: "director", fixed_salary_amd: 300000, user_id: director.id });
  ids.rep = await mk({ name: "ITest Rep", position: "ITest SM", kind: "rep", reports_to: ids.boss, fixed_salary_amd: 200000, visit_based: true, user_id: repUser.id, channel: "SM YVN", commission_basis: "collected", commission_pct: 2, commission_channels: ["SM YVN"] });
  ids.rep2 = await mk({ name: "ITest Rep Two", position: "ITest SM2", kind: "rep", reports_to: ids.boss, fixed_salary_amd: 200000, visit_based: true, user_id: repUser2.id });
  assert.equal((await api("rep", "/people", "POST", { name: "x", position: "y" })).status, 403);
  assert.equal((await api("admin", "/people", "POST", { name: "", position: "y" })).status, 400);
  assert.equal((await api("admin", "/people", "POST", { name: "Dup", position: "ITest Dup", user_id: repUser.id })).status, 409, "one login = one person");
  assert.equal((await api("admin", `/people/${ids.boss}`, "PUT", { reports_to: ids.rep })).status, 400, "the director cannot report to their own rep");
  assert.equal((await api("admin", `/people/${ids.boss}`, "PUT", { reports_to: ids.boss })).status, 400);
  assert.equal((await api("accountant", `/people/${ids.rep}`, "PUT", { fixed_salary_amd: 210000 })).status, 200);
  assert.equal((await api("admin", `/people/${ids.rep}`, "PUT", { fixed_salary_amd: 200000 })).status, 200);
});

test("who sees whom: everyone sees themselves, a boss sees the team, the rest see nothing", async () => {
  const names = async (who) => (await api(who, "/people")).data.people.map((p) => p.id);
  const all = await names("admin");
  assert.ok([ids.boss, ids.rep, ids.rep2].every((i) => all.includes(i)));
  assert.deepEqual((await names("accountant")).filter((i) => Object.values(ids).includes(i)).sort(), Object.values(ids).sort());
  assert.deepEqual((await names("director")).sort(), [ids.boss, ids.rep, ids.rep2].sort());
  assert.deepEqual(await names("rep"), [ids.rep]);
  assert.equal((await api("stranger", "/people")).status, 403);
  // pay detail follows the same scope
  assert.equal((await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).status, 200);
  assert.equal((await api("rep", `/people/${ids.rep2}/pay?month=2026-10`)).status, 403);
  assert.equal((await api("director", `/people/${ids.rep2}/pay?month=2026-10`)).status, 200);
  assert.equal((await api("rep2", `/people/${ids.boss}/pay?month=2026-10`)).status, 403, "a rep never sees the director's salary");
  const payroll = await api("director", "/payroll?month=2026-10");
  assert.equal(payroll.data.rows.length, 3);
  assert.equal((await api("rep", "/payroll?month=2026-10")).data.rows.length, 1);
});

test("marking days: the boss and admin can, the person themselves and the accountant cannot", async () => {
  const day = "2026-10-09";
  assert.equal((await api("rep", `/people/${ids.rep}/days/${day}`, "PUT", { status: "completed" })).status, 403);
  assert.equal((await api("accountant", `/people/${ids.rep}/days/${day}`, "PUT", { status: "completed" })).status, 403);
  assert.equal((await api("director", `/people/${ids.rep}/days/${day}`, "PUT", { status: "bogus" })).status, 400);
  assert.equal((await api("director", `/people/${ids.rep}/days/${day}`, "PUT", { status: "completed", note: "approved for 2 visits only" })).status, 200);
  assert.equal((await api("director", `/people/${ids.boss}/days/${day}`, "PUT", { status: "completed" })).status, 403, "a boss does not mark their own days");
  const pay = (await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).data;
  assert.equal(pay.days.find((d) => d.date === day).state, "paid");
  assert.equal(pay.can_mark, false);
  assert.equal((await api("director", `/people/${ids.rep}/pay?month=2026-10`)).data.can_mark, true);
  assert.equal((await api("director", `/people/${ids.rep}/days/${day}`, "PUT", { status: null })).status, 200);
  assert.equal((await api("admin", `/people/${ids.rep}/pay?month=2026-10`)).data.days.find((d) => d.date === day).mark, null);
});

test("the visit rule reads the approved plan and the rep's check-ins", async () => {
  const customers = [];
  for (let i = 0; i < 4; i++) customers.push(await createCustomer({ created_by: repUser.id, assigned_manager_id: repUser.id }));
  const day = "2026-10-12";
  await pool.query("INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, $2, $3, 'approved', $1)", [repUser.id, day, customers.map((c) => c.id)]);
  for (const c of customers.slice(0, 3)) {
    await pool.query("INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range) VALUES ($1, $2, $3, 40.18, 44.51, 5, true)", [c.id, repUser.id, `${day}T08:00:00Z`]);
  }
  const pay = (await api("director", `/people/${ids.rep}/pay?month=2026-10`)).data;
  const d = pay.days.find((x) => x.date === day);
  assert.equal(d.planned, 4);
  assert.equal(d.done, 3);
  assert.equal(d.pct, 75);
  assert.equal(d.state, "paid", "3 of 4 = 75 % reaches the default threshold");
  // the CEO raises the bar -> the same day no longer pays
  assert.equal((await api("director", "/settings", "PUT", { min_visit_pct: 80 })).status, 403, "the sales director cannot change the company rule");
  assert.equal((await api("admin", "/settings", "PUT", { min_visit_pct: 80 })).data.min_visit_pct, 80);
  assert.equal((await api("director", `/people/${ids.rep}/pay?month=2026-10`)).data.days.find((x) => x.date === day).state, "unpaid");
  assert.equal((await api("admin", "/settings", "PUT", { min_visit_pct: 0 })).status, 400);
  await pool.query("UPDATE app_settings SET staff_settings = NULL WHERE id = 1");
  await pool.query("DELETE FROM visit_plans WHERE user_id = $1 AND plan_date = $2", [repUser.id, day]);
  await pool.query("DELETE FROM checkins WHERE user_id = $1", [repUser.id]);
});

test("premiums, bonuses and deductions: managed by admin / accountant, counted in the month", async () => {
  assert.equal((await api("director", `/people/${ids.rep}/items`, "POST", { month: "2026-10", kind: "premium", amount_amd: 1000 })).status, 403);
  assert.equal((await api("admin", `/people/${ids.rep}/items`, "POST", { month: "2026-10", kind: "gift", amount_amd: 1000 })).status, 400);
  assert.equal((await api("admin", `/people/${ids.rep}/items`, "POST", { month: "2026-10", kind: "premium", amount_amd: -5 })).status, 400);
  const a = await api("accountant", `/people/${ids.rep}/items`, "POST", { month: "2026-10", kind: "premium", amount_amd: 25000, note: "Q3" });
  const b = await api("admin", `/people/${ids.rep}/items`, "POST", { month: "2026-10", kind: "deduction", amount_amd: 4000 });
  assert.equal(a.status, 201);
  let pay = (await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).data;
  assert.equal(pay.premiums, 25000);
  assert.equal(pay.deductions, 4000);
  assert.equal(pay.items.length, 2);
  assert.equal((await api("admin", `/people/${ids.rep}/pay?month=2026-11`)).data.premiums, 0, "another month is untouched");
  assert.equal((await api("director", `/items/${b.data.id}`, "DELETE")).status, 403);
  assert.equal((await api("admin", `/items/${b.data.id}`, "DELETE")).status, 200);
  pay = (await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).data;
  assert.equal(pay.deductions, 0);
});

test("salary payments from Cashflow reduce the balance (position + year + month in the Info text)", async () => {
  const { rows: [cat] } = await pool.query("SELECT id FROM cash_categories WHERE lower(name) = 'salary'");
  const { rows: [acc] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') ON CONFLICT DO NOTHING RETURNING id", [`ITest Acc ${Date.now()}`]);
  const accId = acc?.id ?? (await pool.query("SELECT id FROM cash_accounts LIMIT 1")).rows[0].id;
  await pool.query("UPDATE staff_members SET pay_keys = $2 WHERE id = $1", [ids.rep, ["ITest SM Long"]]);
  const put = (info, amt) =>
    pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, account_id, info, origin) VALUES ('2026-10-20', $1, $1, $2, $3, $4, 'manual')", [-amt, cat.id, accId, info]);
  await put("ITest SM 2026 OCT", 100000);
  await put("ITest SM Long 2026 OCT", 50000); // a second spelling of the same position
  await put("ITest SM 2026 SEP", 77000); // another month
  await put("ITest SM2 2026 OCT", 11000); // another person
  const pay = (await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).data;
  assert.equal(pay.paid, 150000);
  assert.equal(pay.payments, 2);
  assert.equal(pay.balance, pay.total - 150000);
  await pool.query("DELETE FROM cash_entries WHERE info LIKE 'ITest SM%'");
  await pool.query("DELETE FROM cash_accounts WHERE name LIKE 'ITest Acc%'");
});

test("commission: a rep gets the % of the money collected in their channel; the director's exclusions are honoured", async () => {
  const { rows: [cat] } = await pool.query("SELECT id FROM cash_categories WHERE lower(name) = 'oil order'");
  const { rows: [acc] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id", [`ITest Acc2 ${Date.now()}`]);
  const put = (rep, amt) =>
    pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, account_id, sales_rep, info, origin) VALUES ('2026-10-15', $1, $1, $2, $3, $4, 'ITest Pos', 'manual')", [amt, cat.id, acc.id, rep]);
  await put("SM YVN", 1000000);
  await put("SM YVN", 500000);
  await put("SM Shirak", 700000);
  await put("KF", 900000);
  const rep = (await api("rep", `/people/${ids.rep}/pay?month=2026-10`)).data;
  assert.ok(rep.commission.base_amd >= 1500000, "the rep's own channel only (other channels' test money may exist in the shared DB)");
  assert.equal(rep.commission.pct, 2);
  assert.equal(rep.commission.amount, Math.round((rep.commission.base_amd * 2) / 100));
  await api("admin", `/people/${ids.boss}`, "PUT", { commission_basis: "collected", commission_pct: 2, commission_channels: [], commission_excluded: ["KF", "CAS"] });
  const withKf = (await api("director", `/people/${ids.boss}/pay?month=2026-10`)).data;
  await pool.query("DELETE FROM cash_entries WHERE info = 'ITest Pos' AND sales_rep = 'KF'");
  const noKf = (await api("director", `/people/${ids.boss}/pay?month=2026-10`)).data;
  assert.equal(withKf.commission.base_amd, noKf.commission.base_amd, "KF never counts for the director");
  assert.ok(noKf.commission.base_amd >= 2200000);
  await pool.query("DELETE FROM cash_entries WHERE info = 'ITest Pos'");
  await pool.query("DELETE FROM cash_accounts WHERE name LIKE 'ITest Acc2%'");
});
