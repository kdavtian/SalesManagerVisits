// Reports > Gaps and targets (GET /api/market/gaps, POST /api/market/gap-tasks): per line potential vs bought, shops with potential and
// no Castrol on a fresh shelf, one visit task per shop on a tap, never a second open one. Made-up names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { lineTotals, GAP_TASK_TITLE } from "../../src/reports/market/gaps.js";

let rep, rep2, director, cookies = {}, noCastrol, withCastrol, noShelf, competitorsOnly, otherRepShop;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  for (const [k, u] of Object.entries({ rep, rep2, director })) cookies[k] = await loginAs(u.email);
  const mk = async () => createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  noCastrol = await mk();
  withCastrol = await mk();
  noShelf = await mk();
  competitorsOnly = await mk();
  otherRepShop = await createCustomer({ created_by: rep2.id, assigned_manager_id: rep2.id, lat: 40.18, lng: 44.51 });
  const { rows: [line] } = await pool.query("SELECT id FROM volume_potential_lines WHERE code = 'pcmo_5w40'");
  for (const c of [noCastrol, withCastrol, noShelf, competitorsOnly, otherRepShop]) {
    await pool.query("INSERT INTO volume_potential_profiles (customer_id) VALUES ($1)", [c.id]);
    await pool.query("INSERT INTO volume_potential_amounts (customer_id, line_id, amount_month) VALUES ($1, $2, 120)", [c.id, line.id]);
  }
  const shelf = (c, status) =>
    pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status) VALUES ($1, $2, 40.18, 44.51, 5, true, $3)", [c.id, rep.id, JSON.stringify(status)]);
  await shelf(noCastrol, { castrol: ["unavailable"], competitors: ["motul"] });
  await shelf(withCastrol, { castrol: ["available"] });
  await shelf(competitorsOnly, { competitors: ["motul"] }); // Castrol not answered: says nothing about Castrol
  await shelf(otherRepShop, { castrol: ["unavailable"] });
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE customer_id = ANY($1::int[])", [[noCastrol.id, withCastrol.id, noShelf.id, competitorsOnly.id, otherRepShop.id]]);
  await cleanupAll();
  await stopTestServer();
});

test("line totals add up the customers' lines", () => {
  const t = lineTotals(
    [{ lines: [{ line_id: 1, potential: 100, actual: 40, gap: 60 }] }, { lines: [{ line_id: 1, potential: 50, actual: 0, gap: 50 }, { line_id: 2, potential: 10, actual: 10, gap: 0 }] }],
    [{ id: 1, code: "a", name_en: "A", name_hy: "Ա", unit: "L" }, { id: 2, code: "b", name_en: "B", name_hy: "Բ", unit: "L" }]
  );
  assert.deepEqual(t.map((x) => [x.code, x.customers, x.potential, x.actual, x.gap, x.share_pct]), [["a", 2, 150, 40, 110, 27], ["b", 1, 10, 10, 0, 100]]);
});

test("shops with potential and no Castrol; a line filter; tasks once per shop; a rep may not", async () => {
  const r = await apiRequest("/api/market/gaps?line=pcmo_5w40", { cookie: cookies.director });
  assert.equal(r.status, 200);
  const ids = r.data.shops.map((s) => s.customer_id);
  assert.ok(ids.includes(noCastrol.id));
  assert.ok(!ids.includes(withCastrol.id), "genuine Castrol on the shelf");
  assert.ok(!ids.includes(noShelf.id), "no fresh shelf record: not listed");
  assert.ok(!ids.includes(competitorsOnly.id), "Castrol not answered: not listed");
  assert.equal(r.data.shops.find((s) => s.customer_id === noCastrol.id).potential, 120);
  assert.ok(r.data.lines.some((l) => l.code === "pcmo_5w40" && l.potential >= 360));

  const make = (body, who = "director") => apiRequest("/api/market/gap-tasks", { method: "POST", cookie: cookies[who], body });
  assert.equal((await make({ customer_ids: [noCastrol.id] }, "rep")).status, 403);
  const first = await make({ customer_ids: [noCastrol.id], line: "pcmo_5w40" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { created: 1, already_open: 0, no_rep: 0, not_allowed: 0, over_limit: 0 });
  // two taps at once still make one task
  const [a, b] = await Promise.all([make({ customer_ids: [noCastrol.id] }), make({ customer_ids: [noCastrol.id] })]);
  assert.deepEqual([a.data.created + b.data.created, a.data.already_open + b.data.already_open], [0, 2]);
  const { rows } = await pool.query("SELECT title, assignee_id, creator_id, due_is_next_visit FROM tasks WHERE customer_id = $1 AND status = 'open'", [noCastrol.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, new RegExp(`^${GAP_TASK_TITLE}՝ `));
  assert.deepEqual([rows[0].assignee_id, rows[0].creator_id, rows[0].due_is_next_visit], [rep.id, director.id, true]);
  const after = await apiRequest("/api/market/gaps?line=pcmo_5w40", { cookie: cookies.director });
  assert.equal(after.data.shops.find((s) => s.customer_id === noCastrol.id).open_task, true);
});

test("only reps the caller may task; inactive rep = no rep; a rep with the report given still may not create; a rep sees only their shops", async () => {
  // a director with a Staff record whose team is only `rep`: rep2's shop is "not your team"
  await pool.query("INSERT INTO staff_members (user_id, name, position) VALUES ($1, 'Zz Director', 'director')", [director.id]);
  const { rows: staff } = await pool.query("SELECT 1 FROM staff_members WHERE user_id = $1", [director.id]);
  if (staff.length) {
    const r = await apiRequest("/api/market/gap-tasks", { method: "POST", cookie: cookies.director, body: { customer_ids: [otherRepShop.id] } });
    assert.equal(r.data.not_allowed, 1);
    await pool.query("DELETE FROM staff_members WHERE user_id = $1", [director.id]);
  }
  await pool.query("UPDATE users SET status = 'paused' WHERE id = $1", [rep2.id]);
  const paused = await apiRequest("/api/market/gap-tasks", { method: "POST", cookie: cookies.director, body: { customer_ids: [otherRepShop.id] } });
  assert.equal(paused.data.no_rep, 1);
  const list = await apiRequest("/api/market/gaps", { cookie: cookies.director });
  assert.equal(list.data.shops.find((s) => s.customer_id === otherRepShop.id)?.rep_id ?? null, null, "a paused rep's shop cannot be picked");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [rep2.id]);
  // management gives the report to sales managers: they see their own shops only, and still cannot create tasks
  await pool.query("INSERT INTO report_access (report_key, role, enabled) VALUES ('market_gaps', 'sales_manager', true) ON CONFLICT (report_key, role) DO UPDATE SET enabled = true");
  try {
    const mine = await apiRequest("/api/market/gaps", { cookie: cookies.rep2 });
    assert.equal(mine.status, 200);
    assert.ok(mine.data.shops.every((s) => s.customer_id === otherRepShop.id));
    assert.equal((await apiRequest("/api/market/gap-tasks", { method: "POST", cookie: cookies.rep2, body: { customer_ids: [otherRepShop.id] } })).status, 403);
  } finally {
    await pool.query("DELETE FROM report_access WHERE report_key = 'market_gaps' AND role = 'sales_manager'");
  }
});
