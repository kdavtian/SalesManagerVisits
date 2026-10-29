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
