// Vaghinak's full daily digest (owner, 2026-10-29): every working evening ONE message to the CEO and the admin only -- the company's
// day, every active person's day by their job, and recommendations, the most important first.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { fullDigest, personSummary } from "../../src/team/vaghinak/fullDigest.js";

const DAY = "2026-10-28"; // a Wednesday
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+04:00`);
let rep, idle, ceo, admin, director, customer;

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager", { name: "Digest Rep" });
  idle = await createUser("sales_manager", { name: "Digest Idle" });
  ceo = await createUser("ceo");
  admin = await createUser("admin");
  director = await createUser("sales_director");
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE users SET last_seen_at = $2 WHERE id = $1", [rep.id, at("12:00")]);
  for (const t of ["10:05", "11:30", "13:10"]) {
    const { rows } = await pool.query("INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range) VALUES ($1, $2, $3, 40.18, 44.51, 5, true) RETURNING id", [customer.id, rep.id, at(t)]);
    trackCheckin(rows[0].id);
  }
  // the idle rep had a plan and did nothing, and holds cash for 4 days
  await pool.query("INSERT INTO vaghinak_day_log (user_id, day, planned_count, visited_count) VALUES ($1, $2, 6, 0), ($3, $2, 4, 3)", [idle.id, DAY, rep.id]);
  await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id, created_at)
     VALUES ($1, 'x', 150000, $3, $2, 'Digest Idle', 'pending', $2, $2, $3)`,
    [customer.id, idle.id, new Date(`2026-10-24T12:00:00+04:00`)]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [idle.id]);
  await pool.query("DELETE FROM vaghinak_day_log WHERE day = $1", [DAY]);
  await pool.query("DELETE FROM vaghinak_messages WHERE kind = 'full_digest' AND day = $1", [DAY]);
  await cleanupAll();
  await stopTestServer();
});

test("not before the end of the work day; then one message to the CEO and the admin only, once", async () => {
  assert.equal((await fullDigest(at("16:00"), pool, { delayMaxMs: 0 })).created, 0, "the day is not over yet");
  const first = await fullDigest(at("18:30"), pool, { delayMaxMs: 0 });
  assert.ok(first.created >= 2);
  const { rows } = await pool.query("SELECT user_id, body, shadow FROM vaghinak_messages WHERE kind = 'full_digest' AND day = $1", [DAY]);
  const to = new Set(rows.map((r) => r.user_id));
  assert.ok(to.has(ceo.id) && to.has(admin.id));
  assert.ok(!to.has(director.id) && !to.has(rep.id), "nobody else gets it");
  const body = rows.find((r) => r.user_id === ceo.id).body;
  assert.equal(rows.find((r) => r.user_id === ceo.id).shadow, false, "it reaches them whatever Vaghinak's mode");
  assert.match(body, /Digest Rep/);
  assert.match(body, /այցեր 3\/4/, "the rep's visits against the plan");
  assert.match(body, /Digest Idle — այսօր ոչ մի այց/, "the most important recommendation first");
  assert.match(body, /կանխիկը մոտն է 4 օր \(150,000 դր\)/);
  assert.equal((await fullDigest(at("19:00"), pool, { delayMaxMs: 0 })).created, 0, "once a day");
});

test("recommendations by job: delivery stops left, overdue tasks, the app not opened today", () => {
  const base = { visits: null, plan: null, orders: null, payments: null, cash: null, tasksDone: 0, overdue: 0, packed: 0, confirmed: 0, stops: null, approved: 0, recorded: 0 };
  const driver = personSummary({ ...base, user: { name: "Driver", role: "delivery_manager", seen_today: true }, stops: { total: 5, done: 3 } });
  assert.deepEqual(driver.parts, ["առաքում 3/5"]);
  assert.equal(driver.recos[0].text, "2 կանգառ չի ավարտվել");
  const acc = personSummary({ ...base, user: { name: "Acc", role: "accountant", seen_today: false }, overdue: 4, approved: 2 });
  assert.deepEqual(acc.recos.map((r) => r.text), ["ժամկետանց առաջադրանքներ՝ 4", "այսօր հավելվածը չի բացել"]);
});

// Owner, 2026-11-10: "analyze the report, detect false info and fix".
test("cash 'on hand' is the app's own definition: an approved or already received payment is not cash anyone holds", async () => {
  const holder = await createUser("sales_manager", { name: "Digest Holder" });
  const insert = (amount, status, daysAgo, extra = "") =>
    pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id, created_at ${extra ? ", approved_by" : ""})
       VALUES ($1, 'x', $2, $3, $4, 'Digest Holder', $5, $4, $4, $3 ${extra ? ", $6" : ""})`,
      extra ? [customer.id, amount, new Date(Date.now() - daysAgo * 86400000), holder.id, status, director.id] : [customer.id, amount, new Date(Date.now() - daysAgo * 86400000), holder.id, status]
    );
  await insert(40000, "pending", 3); // really in his pocket, 3 days
  await insert(900000, "approved", 60, "by"); // approved by a person long ago: the company has it
  const { dayFacts } = await import("../../src/team/vaghinak/fullDigest.js");
  const today = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
  const mine = (await dayFacts(pool, today)).find((f) => f.user.id === holder.id);
  assert.equal(Number(mine.cash.amd), 40000, "only the pending cash");
  assert.equal(mine.cash.days, 3);
  await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [holder.id]);
});

test("a plan is measured by the PLANNED customers visited: visits outside the plan do not fill it, they are shown apart", () => {
  const base = { orders: null, payments: null, cash: null, tasksDone: 0, overdue: 0, packed: 0, confirmed: 0, stops: null, approved: 0, recorded: 0 };
  const rep = personSummary({ ...base, user: { name: "Rep", role: "sales_manager", seen_today: true }, visits: { n: 6 }, plan: { planned_count: 10, visited_count: 2 } });
  assert.match(rep.parts[0], /այցեր 2\/10 \(20%\) \+ 4 պլանից դուրս/);
  assert.ok(rep.recos.some((r) => /պլանի միայն 20%/.test(r.text)), "6 check-ins no longer hide a plan that is 20% done");
  const noPlan = personSummary({ ...base, user: { name: "Rep", role: "sales_manager", seen_today: true }, visits: { n: 4 }, plan: null });
  assert.equal(noPlan.parts[0], "այցեր 4");
});

test("overdue tasks say how old the oldest is", () => {
  const base = { visits: null, plan: null, orders: null, payments: null, cash: null, tasksDone: 0, packed: 0, confirmed: 0, stops: null, approved: 0, recorded: 0 };
  const p = personSummary({ ...base, user: { name: "Acc", role: "accountant", seen_today: true }, overdue: 4, overdueOldest: 41 });
  assert.equal(p.recos[0].text, "ժամկետանց առաջադրանքներ՝ 4 (ամենահինը՝ 41 օր)");
});

test("company totals: bank / card payments count, the old module's copies are not counted twice, and 'usual' skips a day nobody worked", async () => {
  const { companyTotals } = await import("../../src/team/vaghinak/fullDigest.js");
  const day = "2026-11-04"; // a Wednesday: the four before it are 28 Oct, 21 Oct, 14 Oct, 7 Oct
  const insertPay = (source, amount, payDay, extra = {}) =>
    pool.query(
      `INSERT INTO customer_payments (customer_id, customer_name_snapshot, amount_amd, paid_at, pay_day, method, source, collected_by, created_by)
       VALUES ($1, 'x', $2, $3, $4, 'bank', $5, $6, $6)`,
      [customer.id, amount, `${payDay}T10:00:00+04:00`, payDay, source, director.id]
    );
  const before = await companyTotals(pool, day);
  await insertPay("bank", 70000, day);
  await insertPay("bridge", 999999, day); // the copy of an old-module payment: counted there, not here
  await insertPay("bank", 50000, "2026-10-28");
  await insertPay("bank", 90000, "2026-10-21");
  const after = await companyTotals(pool, day);
  assert.equal(Number(after.today.paid_amd) - Number(before.today.paid_amd), 70000, "bank payment counted, bridge copy not");
  assert.ok(after.usualDays <= 4);
  await pool.query("DELETE FROM customer_payments WHERE customer_id = $1", [customer.id]);
});
