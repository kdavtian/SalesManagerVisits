// Vaghinak end to end: the engine reads real check-ins and plans, writes messages (shadow first, then live), asks
// the mandatory question, takes the answer, stays quiet for a day off, and the wrap-up / management brief appear.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { tick, wrapUp } from "../../src/vaghinak/engine.js";
import { saveVaghinakSettings } from "../../src/vaghinak/settings.js";

// A fixed Monday in the past: 2026-10-12. "at(h, m)" = that day at h:m Yerevan time (UTC+4).
const DAY = "2026-10-12";
const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 12, h - 4, m));
let admin, adminCookie, rep, repCookie, other, otherCookie, officeCust, custs;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager", { name: "Artak Test Rep" });
  other = await createUser("sales_manager", { name: "Other Rep" });
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
  officeCust = await createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "Vaghinak Office" });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [officeCust.id]);
  custs = [];
  for (let i = 0; i < 6; i++) custs.push(await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `VG Customer ${i}` }));
  await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, created_by, customer_ids) VALUES ($1, 1, $2, $3)", [rep.id, admin.id, custs.map((c) => c.id)]);
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = ANY($1)", [[rep.id, other.id]]);
  await pool.query("DELETE FROM vaghinak_settings");
  await pool.query("UPDATE customers SET checkin_for_all = false WHERE id = $1", [officeCust.id]);
  await cleanupAll();
  await stopTestServer();
});

const checkin = (user, cust, when) =>
  pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp) VALUES ($1, $2, 40.18, 44.51, 5, true, $3)", [cust.id, user.id, when]);
const messages = async (user, filter = "") => (await pool.query(`SELECT * FROM vaghinak_messages WHERE user_id = $1 ${filter} ORDER BY level, kind`, [user.id])).rows;
const clean = async () => {
  await pool.query("DELETE FROM vaghinak_messages WHERE user_id = ANY($1)", [[rep.id, other.id, admin.id]]);
  await pool.query("DELETE FROM vaghinak_day_log WHERE user_id = ANY($1)", [[rep.id, other.id]]);
  await pool.query("DELETE FROM checkins WHERE user_id = ANY($1)", [[rep.id, other.id]]);
  await pool.query("UPDATE users SET vaghinak_muted_day = NULL WHERE id = ANY($1)", [[rep.id, other.id]]);
};

test("shadow mode (the default): he works, but nothing reaches the rep; management sees what he would say", async () => {
  await clean();
  await checkin(rep, officeCust, at(9, 30));
  const r = await tick(at(11, 45), pool, { pick: () => 0 });
  assert.equal(r.created >= 1, true);
  const msgs = await messages(rep);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "office_long");
  assert.equal(msgs[0].shadow, true);
  assert.equal((await apiRequest("/api/vaghinak/badge", { cookie: repCookie })).data.count, 0, "rep sees nothing in shadow mode");
  assert.equal((await apiRequest("/api/vaghinak/pending", { cookie: repCookie })).data, null);
  const feed = await apiRequest("/api/vaghinak/feed", { cookie: adminCookie });
  assert.ok(feed.data.some((m) => m.user_name.includes("Artak") && m.shadow));
  assert.equal((await apiRequest("/api/vaghinak/feed", { cookie: repCookie })).status, 403);
});

test("live: reminder, then the mandatory question; the badge counts; answering clears the block; no repeats", async () => {
  await clean();
  await saveVaghinakSettings({ mode: "live" });
  await checkin(rep, officeCust, at(9, 30));
  await tick(at(11, 45), pool, { pick: () => 0 });
  let msgs = await messages(rep);
  assert.deepEqual(msgs.map((m) => `${m.kind}:${m.level}`), ["office_long:1"]);
  assert.ok(msgs[0].body.includes("6"), "mentions the 6 visits left");
  assert.ok(!msgs[0].body.includes("{"));
  assert.equal((await apiRequest("/api/vaghinak/badge", { cookie: repCookie })).data.count, 1);
  assert.equal((await apiRequest("/api/vaghinak/pending", { cookie: repCookie })).data, null, "a reminder never blocks");

  await tick(at(11, 50), pool, { pick: () => 0 });
  assert.equal((await messages(rep)).length, 1, "same situation: no second message");

  await tick(at(12, 40), pool, { pick: () => 0 });
  msgs = await messages(rep);
  assert.deepEqual(msgs.map((m) => `${m.kind}:${m.level}`), ["office_long:1", "office_long:2"]);
  assert.equal(msgs[1].mandatory, true);
  const pending = (await apiRequest("/api/vaghinak/pending", { cookie: repCookie })).data;
  assert.equal(pending.id, msgs[1].id);
  assert.ok(pending.choices.length >= 4);

  assert.equal((await apiRequest(`/api/vaghinak/messages/${pending.id}/answer`, { method: "POST", cookie: repCookie, body: {} })).status, 400, "cannot skip with an empty answer");
  assert.equal((await apiRequest(`/api/vaghinak/messages/${pending.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: "other" } })).status, 400, "'other' needs a few words");
  assert.equal((await apiRequest(`/api/vaghinak/messages/${pending.id}/answer`, { method: "POST", cookie: otherCookie, body: { choice: "meeting" } })).status, 404, "not somebody else's question");
  const ok = await apiRequest(`/api/vaghinak/messages/${pending.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: "meeting", text: "Ժողով ունեի" } });
  assert.equal(ok.status, 200);
  assert.equal((await apiRequest("/api/vaghinak/pending", { cookie: repCookie })).data, null);
  assert.equal((await apiRequest(`/api/vaghinak/messages/${pending.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: "meeting" } })).status, 409, "answered once");

  const qa = (await apiRequest("/api/vaghinak/qa", { cookie: adminCookie })).data;
  assert.ok(qa.some((q) => q.id === pending.id && q.answer_choice === "meeting" && q.answer_text === "Ժողով ունեի"));
  assert.equal((await apiRequest("/api/vaghinak/qa", { cookie: repCookie })).status, 403);
});

test("late within 30 minutes is silent but logged; later is a friendly word; the log keeps the delay", async () => {
  await clean();
  await checkin(rep, custs[0], at(9, 55)); // 25 min late
  await checkin(other, custs[1], at(10, 20)); // 50 min late
  await tick(at(11, 0), pool, { pick: () => 0 });
  assert.equal((await messages(rep)).length, 0, "25 min is within the grace: quiet");
  assert.deepEqual((await messages(other)).map((m) => m.kind), ["late_start"]);
  const log = (await pool.query("SELECT user_id, late_minutes FROM vaghinak_day_log WHERE day = $1 AND user_id = ANY($2)", [DAY, [rep.id, other.id]])).rows;
  assert.equal(log.find((l) => l.user_id === rep.id).late_minutes, 25);
  assert.equal(log.find((l) => l.user_id === other.id).late_minutes, 50);
});

test("stopped with planned visits left: reminder; a 'day off' answer mutes him for the day", async () => {
  await clean();
  await checkin(rep, custs[0], at(9, 40));
  await checkin(rep, custs[1], at(10, 30));
  await tick(at(12, 0), pool, { pick: () => 0 });
  assert.deepEqual((await messages(rep)).map((m) => `${m.kind}:${m.level}`), ["stopped_early:1"]);
  const msg = (await messages(rep))[0];
  assert.ok(msg.body.includes("4"), "4 customers are still planned");

  await clean();
  await tick(at(10, 40), pool, { pick: () => 0 }); // nobody has checked in: asks
  const ask = (await messages(rep)).find((m) => m.kind === "not_started");
  assert.ok(ask && ask.needs_answer && !ask.mandatory);
  await apiRequest(`/api/vaghinak/messages/${ask.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: "day_off" } });
  const muted = (await pool.query("SELECT to_char(vaghinak_muted_day, 'YYYY-MM-DD') AS d FROM users WHERE id = $1", [rep.id])).rows[0].d;
  assert.equal(muted, new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10), "muted for today");
  await pool.query("UPDATE users SET vaghinak_muted_day = $2 WHERE id = $1", [rep.id, DAY]); // the test clock is a fixed past Monday
  const before = (await messages(rep)).length;
  await tick(at(12, 0), pool, { pick: () => 0 });
  assert.equal((await messages(rep)).length, before, "muted for the day: no escalation");
});

test("wrap-up: a message for the rep (praise by result) and the management brief; settings are admin-only; 'off' silences him", async () => {
  await clean();
  await pool.query("UPDATE users SET vaghinak_muted_day = NULL WHERE id = ANY($1)", [[rep.id, other.id]]);
  for (let i = 0; i < 5; i++) await checkin(rep, custs[i], at(9, 40 + i * 20));
  await tick(at(17, 25), pool, { pick: () => 0 });
  const r = await wrapUp(at(17, 40), pool, { pick: () => 0 });
  assert.ok(r.created >= 2);
  const wrap = (await messages(rep)).find((m) => m.kind.startsWith("day_wrap"));
  assert.equal(wrap.kind, "day_wrap_high", "5 of 6 planned = 83%");
  const brief = (await messages(admin)).find((m) => m.kind.startsWith("mgmt_brief"));
  assert.ok(brief, "management gets a brief");
  assert.ok(!brief.body.includes("{"));
  assert.equal(brief.shadow, false, "the brief is for management whatever the mode");
  assert.equal((await wrapUp(at(17, 50), pool)).created, 0, "once per day");

  assert.equal((await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: repCookie, body: { mode: "live" } })).status, 403);
  assert.equal((await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: adminCookie, body: { mode: "nonsense" } })).status, 400);
  assert.equal((await apiRequest("/api/vaghinak/settings", { method: "PUT", cookie: adminCookie, body: { mode: "off" } })).data.mode, "off");
  await clean();
  await checkin(rep, officeCust, at(9, 30));
  assert.equal((await tick(at(12, 40), pool)).created, 0, "off = silent");
  await saveVaghinakSettings({ mode: "live" });
});

test("automatic tasks show Vaghinak as the creator", async () => {
  const task = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind) VALUES ('VG auto', $1, $2, $3, current_date, true, 'debt_collection') RETURNING id",
    [admin.id, rep.id, custs[0].id]
  );
  const res = await apiRequest(`/api/tasks/${task.rows[0].id}`, { cookie: adminCookie });
  assert.equal(res.data.creator_name, "Վաղինակ");
  await pool.query("DELETE FROM tasks WHERE id = $1", [task.rows[0].id]);
});

// ---- chasers (missing customer data, orders waiting): fixtures live here so the whole file runs in sequence ----
const CH_DAY = "2026-10-12";
const CH_STAMP = Date.now();
let chAdmin, chDirector, chWarehouse, chRep, chRepCookie, chNoPhone, chComplete, chUnowned, chProduct;
test.before(async () => {
  chAdmin = await createUser("admin");
  chDirector = await createUser("sales_director");
  chWarehouse = await createUser("warehouse_manager");
  chRep = await createUser("sales_manager", { name: "Chase Rep" });
  chRepCookie = await loginAs(chRep.email);
  chProduct = await createProduct({ unit: "4L" });
  chNoPhone = await createCustomer({ created_by: chAdmin.id, assigned_manager_id: chRep.id, name: "No Phone Garage", erp_customer_id: `CH-${CH_STAMP}-1` });
  chComplete = await createCustomer({ created_by: chAdmin.id, assigned_manager_id: chRep.id, name: "Complete Garage", erp_customer_id: `CH-${CH_STAMP}-2` });
  chUnowned = await createCustomer({ created_by: chAdmin.id, name: "Nobody Garage", erp_customer_id: `CH-${CH_STAMP}-3` });
  await pool.query("UPDATE customers SET phone = NULL, region = NULL, sales_channel = 'SM YVN' WHERE id = $1", [chNoPhone.id]);
  await pool.query("UPDATE customers SET phone = '+37491000000', region = 'Yerevan', sales_channel = 'SM YVN' WHERE id = $1", [chComplete.id]);
  await pool.query("UPDATE customers SET assigned_manager_id = NULL, sales_channel = NULL WHERE id = $1", [chUnowned.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'data_missing'");
});

const chaseMsgs = async (userId) => (await pool.query("SELECT kind, shadow, body FROM vaghinak_messages WHERE user_id = $1 AND day = $2 ORDER BY id", [userId, CH_DAY])).rows;
const chaseClean = async () => {
  await pool.query("DELETE FROM vaghinak_messages WHERE user_id = ANY($1)", [[chRep.id, chDirector.id, chWarehouse.id, chAdmin.id]]);
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'data_missing'");
};

test("shadow mode: only a shadow message about missing data, no task reaches the chRep", async () => {
  await chaseClean();
  await saveVaghinakSettings({ mode: "shadow" });
  await tick(at(10, 0), pool, { pick: () => 0 });
  const m = (await chaseMsgs(chRep.id)).find((x) => x.kind === "data_chase");
  assert.ok(m && m.shadow);
  assert.ok(m.body.includes("No Phone Garage"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks WHERE auto_kind = 'data_missing'")).rows[0].n, 0);
});

test("live: a next-visit task for the chRep's customer with missing data (not for chComplete ones), one for the chUnowned customer to the sales chDirector; closes itself when filled", async () => {
  await chaseClean();
  await saveVaghinakSettings({ mode: "live" });
  await tick(at(10, 0), pool, { pick: () => 0 });
  const mine = (await pool.query("SELECT t.id, t.customer_id, t.due_is_next_visit, t.title FROM tasks t WHERE t.auto_kind = 'data_missing' AND t.assignee_id = $1 AND t.status = 'open'", [chRep.id])).rows;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].customer_id, chNoPhone.id);
  assert.equal(mine[0].due_is_next_visit, true);
  const items = (await pool.query("SELECT text FROM task_items WHERE task_id = $1 ORDER BY sort_order", [mine[0].id])).rows.map((r) => r.text);
  assert.equal(items.length, 2, "phone and region");
  const dirTasks = (await pool.query("SELECT title FROM tasks WHERE auto_kind = 'data_missing' AND assignee_id = $1 AND status = 'open'", [chDirector.id])).rows;
  assert.ok(dirTasks.length >= 1, "chUnowned customers go to the sales chDirector");
  assert.ok((await chaseMsgs(chDirector.id)).some((x) => x.kind === "data_chase_owner" && !x.shadow));
  // asked once: a second pass the same day changes nothing
  await tick(at(11, 0), pool, { pick: () => 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks WHERE auto_kind = 'data_missing' AND assignee_id = $1", [chRep.id])).rows[0].n, 1);
  // the chRep fills the data -> the task closes by itself
  await pool.query("UPDATE customers SET phone = '+37491111111', region = 'Yerevan' WHERE id = $1", [chNoPhone.id]);
  await tick(at(12, 0), pool, { pick: () => 0 });
  assert.equal((await pool.query("SELECT status FROM tasks WHERE id = $1", [mine[0].id])).rows[0].status, "done");
  // mandatory customer fields are untouched: a customer can still be created without phone and region
  const created = await apiRequest("/api/customers", { method: "POST", cookie: chRepCookie, body: { name: "Bare Customer", lat: 40.18, lng: 44.51 } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  await pool.query("DELETE FROM customers WHERE id = $1", [created.data.id]);
});

test("orders waiting over the limit: the person who holds the step is told; twice the limit also reaches the CEO/chAdmin", async () => {
  await chaseClean();
  await saveVaghinakSettings({ mode: "live" });
  const make = async () => {
    const r = await apiRequest("/api/orders", { method: "POST", cookie: chRepCookie, body: { customer_id: chComplete.id, payment_method: "cash", items: [{ product_id: chProduct.id, quantity: 1 }] } });
    assert.equal(r.status, 201);
    trackOrder(r.data.id);
    return r.data.id;
  };
  const a = await make();
  // 'submitted' 9 hours ago (limit 4 h, so over, but not twice over)
  await pool.query("UPDATE orders SET created_at = $2, status = 'submitted', approval_status = 'not_required' WHERE id = $1", [a, new Date(at(10, 0).getTime() - 9 * 3600 * 1000)]);
  await tick(at(10, 0), pool, { pick: () => 0 });
  assert.ok((await chaseMsgs(chDirector.id)).some((x) => x.kind === "order_waiting_confirm"), "the sales chDirector holds the confirm step");
  assert.equal((await chaseMsgs(chAdmin.id)).some((x) => x.kind === "order_waiting_escalation"), true, "9 h > 2 x 4 h: the chAdmin hears about it too");
  assert.equal((await chaseMsgs(chRep.id)).some((x) => x.kind.startsWith("order_waiting")), false, "never the chRep");

  await chaseClean();
  await pool.query("UPDATE orders SET status = 'confirmed', updated_at = $2 WHERE id = $1", [a, new Date(at(10, 0).getTime() - 30 * 3600 * 1000)]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'submitted', 'confirmed', $2)", [a, new Date(at(10, 0).getTime() - 30 * 3600 * 1000)]);
  await tick(at(10, 0), pool, { pick: () => 0 });
  assert.ok((await chaseMsgs(chWarehouse.id)).some((x) => x.kind === "order_waiting_pack"), "the chWarehouse manager holds the pack step");
  await pool.query("DELETE FROM order_status_history WHERE order_id = $1", [a]);
});
