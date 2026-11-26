// Reports > Gaps and targets (GET /api/market/gaps, POST /api/market/gap-tasks): per line potential vs bought, shops with potential and
// no Castrol on a fresh shelf, one visit task per shop on a tap, never a second open one. Made-up names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { lineTotals, GAP_TASK_TITLE } from "../../src/reports/market/gaps.js";

let rep, director, cookies = {}, noCastrol, withCastrol, noShelf;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  for (const [k, u] of Object.entries({ rep, director })) cookies[k] = await loginAs(u.email);
  const mk = async () => createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  noCastrol = await mk();
  withCastrol = await mk();
  noShelf = await mk();
  const { rows: [line] } = await pool.query("SELECT id FROM volume_potential_lines WHERE code = 'pcmo_5w40'");
  for (const c of [noCastrol, withCastrol, noShelf]) {
    await pool.query("INSERT INTO volume_potential_profiles (customer_id) VALUES ($1)", [c.id]);
    await pool.query("INSERT INTO volume_potential_amounts (customer_id, line_id, amount_month) VALUES ($1, $2, 120)", [c.id, line.id]);
  }
  const shelf = (c, status) =>
    pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status) VALUES ($1, $2, 40.18, 44.51, 5, true, $3)", [c.id, rep.id, JSON.stringify(status)]);
  await shelf(noCastrol, { castrol: ["unavailable"], competitors: ["motul"] });
  await shelf(withCastrol, { castrol: ["available"] });
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE customer_id = ANY($1::int[])", [[noCastrol.id, withCastrol.id, noShelf.id]]);
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
  assert.equal(r.data.shops.find((s) => s.customer_id === noCastrol.id).potential, 120);
  assert.ok(r.data.lines.some((l) => l.code === "pcmo_5w40" && l.potential >= 360));

  const make = (body, who = "director") => apiRequest("/api/market/gap-tasks", { method: "POST", cookie: cookies[who], body });
  assert.equal((await make({ customer_ids: [noCastrol.id] }, "rep")).status, 403);
  const first = await make({ customer_ids: [noCastrol.id], line: "pcmo_5w40" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { created: 1, already_open: 0, no_rep: 0 });
  const again = await make({ customer_ids: [noCastrol.id] });
  assert.deepEqual(again.data, { created: 0, already_open: 1, no_rep: 0 });
  const { rows } = await pool.query("SELECT title, assignee_id, creator_id, due_is_next_visit FROM tasks WHERE customer_id = $1 AND status = 'open'", [noCastrol.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, new RegExp(`^${GAP_TASK_TITLE}՝ `));
  assert.deepEqual([rows[0].assignee_id, rows[0].creator_id, rows[0].due_is_next_visit], [rep.id, director.id, true]);
  const after = await apiRequest("/api/market/gaps?line=pcmo_5w40", { cookie: cookies.director });
  assert.equal(after.data.shops.find((s) => s.customer_id === noCastrol.id).open_task, true);
});
