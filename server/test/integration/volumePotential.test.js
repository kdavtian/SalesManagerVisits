// Customer volume potential (customers/volumePotential.js), phase 1: save and read, the total = the customer's monthly need (one number,
// the funnel's), the history, a save sent twice from the offline queue, the input checks, the brands taken from the last shelf check, who may
// read / save / change the catalogue.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, rep2, director, accountant, mine, others, cookies = {}, lines;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  for (const [k, u] of Object.entries({ rep, rep2, director, accountant })) cookies[k] = await loginAs(u.email);
  mine = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  others = await createCustomer({ created_by: rep2.id, assigned_manager_id: rep2.id });
  lines = (await apiRequest("/api/volume-potential/lines", { cookie: cookies.rep })).data.lines;
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const url = (c) => `/api/volume-potential/customers/${c.id}`;
const save = (who, c, body) => apiRequest(url(c), { method: "PUT", cookie: cookies[who], body });
const line = (code) => lines.find((l) => l.code === code);

test("the catalogue is seeded (litres, grease in kg, Castrol hints) and the option lists come with it", async () => {
  const r = await apiRequest("/api/volume-potential/lines", { cookie: cookies.rep });
  assert.equal(r.status, 200);
  assert.ok(line("pcmo_5w30") && line("hdeo_15w40") && line("ev_thermal") && line("coolant"));
  assert.equal(line("grease").unit, "kg");
  assert.equal(line("atf").castrol_hint, "Transmax");
  assert.ok(r.data.services.some((s) => s.key === "atf_flush" && s.machine));
  assert.equal(r.data.can_edit_lines, false);
});

test("a rep saves their own customer's potential; the total is the monthly need; every save is in the history", async () => {
  const body = {
    cars_per_month: 120,
    bays: 3,
    vehicle_mix: ["passenger", "asian"],
    brands: ["mobil", "castrol"],
    services: { engine_oil: { does: true, buys: true }, atf_flush: { does: true, buys: false, machine: true }, tyres: { does: false } },
    lines: [
      { line_id: line("pcmo_5w30").id, amount: 200, our_share_pct: 40 },
      { line_id: line("atf").id, amount: 30 },
      { line_id: line("grease").id, amount: 0 }, // nothing = not stored
    ],
    total_l: 250,
    source: "customer_stated",
    confidence: "med",
  };
  const r = await save("rep", mine, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total_l, 250);
  assert.equal(r.data.lines.length, 2);
  assert.deepEqual(r.data.profile.services.atf_flush, { does: true, buys: false, machine: true });
  assert.deepEqual(r.data.profile.services.tyres, { does: false, buys: null, machine: null }, "tyres: no 'buys from us' question");
  const c = (await pool.query("SELECT expected_volume_l::float8 AS l, expected_volume_by FROM customers WHERE id = $1", [mine.id])).rows[0];
  assert.deepEqual([c.l, c.expected_volume_by], [250, rep.id], "one number: the funnel's monthly need");
  // the card's badge date comes with the customer
  assert.ok((await apiRequest(`/api/customers/${mine.id}`, { cookie: cookies.rep })).data.volume_potential_at);

  // change it: lines replaced, history keeps before / after
  const r2 = await save("rep", mine, { ...body, lines: [{ line_id: line("pcmo_5w30").id, amount: 180 }], total_l: 220 });
  assert.equal(r2.data.lines.length, 1);
  const hist = (await apiRequest(`${url(mine)}/history`, { cookie: cookies.rep })).data;
  assert.equal(hist.length, 2);
  assert.equal(hist[0].before.total_l, 250);
  assert.equal(hist[0].after.total_l, 220);
  assert.equal(hist[1].before, null, "the first save has no before");
});

test("the same save sent twice from the offline queue is saved once", async () => {
  const body = { cars_per_month: 50, total_l: 90, client_ref: `vp-${Date.now()}` };
  assert.equal((await save("rep", mine, body)).status, 200);
  const again = await save("rep", mine, body);
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM volume_potential_history WHERE client_ref = $1", [body.client_ref])).rows[0].n, 1);
});

test("bad values are refused; leaving the total out keeps the monthly need", async () => {
  for (const bad of [{ cars_per_month: -1 }, { bays: 1.5 }, { vehicle_mix: ["boats"] }, { brands: ["nope"] }, { services: { flying: { does: true } } }, { lines: [{ line_id: 999999, amount: 5 }] }, { lines: [{ line_id: line("atf").id, amount: -3 }] }, { lines: [{ line_id: line("atf").id, amount: 3, our_share_pct: 150 }] }, { source: "guess" }, { total_l: -5 }]) {
    assert.equal((await save("rep", mine, bad)).status, 400, JSON.stringify(bad));
  }
  const before = (await pool.query("SELECT expected_volume_l::float8 AS l FROM customers WHERE id = $1", [mine.id])).rows[0].l;
  assert.equal((await save("rep", mine, { cars_per_month: 10 })).status, 200);
  assert.equal((await pool.query("SELECT expected_volume_l::float8 AS l FROM customers WHERE id = $1", [mine.id])).rows[0].l, before);
});

test("who may read and save: own rep and management yes, another rep and the accountant no", async () => {
  assert.equal((await apiRequest(url(others), { cookie: cookies.rep })).status, 403);
  assert.equal((await save("rep", others, { bays: 1 })).status, 403);
  assert.equal((await apiRequest(url(mine), { cookie: cookies.accountant })).status, 403);
  assert.equal((await apiRequest(url(others), { cookie: cookies.director })).status, 200);
  assert.equal((await save("director", others, { bays: 2 })).status, 200);
  assert.equal((await apiRequest("/api/volume-potential/customers/999999999", { cookie: cookies.director })).status, 404);
});

test("nothing saved yet: the brands start from the last shelf check", async () => {
  const fresh = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, brand_status, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], '{"castrol":["available"],"competitors":["mobil","aral"]}'::jsonb, now())`,
    [fresh.id, rep.id]
  );
  try {
    const r = await apiRequest(url(fresh), { cookie: cookies.rep });
    assert.equal(r.data.profile, null);
    assert.deepEqual(r.data.brands_from_visits, ["castrol", "mobil"], "Castrol on the shelf + the competitors the profile knows");
  } finally {
    await pool.query("DELETE FROM checkins WHERE customer_id = $1", [fresh.id]);
  }
});

test("the catalogue: management changes and adds lines, a rep cannot; a switched-off line is hidden from the sheet", async () => {
  const atf = line("atf");
  assert.equal((await apiRequest(`/api/volume-potential/lines/${atf.id}`, { method: "PUT", cookie: cookies.rep, body: { ...atf } })).status, 403);
  const added = await apiRequest("/api/volume-potential/lines", { method: "POST", cookie: cookies.director, body: { name_en: "Test line", name_hy: "Փորձ", unit: "L", group_key: "other", sort_order: 999, active: false } });
  assert.equal(added.status, 201);
  try {
    assert.ok(!(await apiRequest("/api/volume-potential/lines", { cookie: cookies.rep })).data.lines.some((l) => l.id === added.data.id), "switched off: not on the sheet");
    assert.ok((await apiRequest("/api/volume-potential/lines?all=1", { cookie: cookies.director })).data.lines.some((l) => l.id === added.data.id));
    const changed = await apiRequest(`/api/volume-potential/lines/${added.data.id}`, { method: "PUT", cookie: cookies.director, body: { ...added.data, castrol_hint: "Transmax", active: true } });
    assert.equal(changed.data.castrol_hint, "Transmax");
  } finally {
    await pool.query("DELETE FROM volume_potential_lines WHERE id = $1", [added.data.id]);
  }
});

test("review fixes: a switched-off line keeps its amount; a blank total keeps the need; an older offline save never overwrites a newer need", async () => {
  const c = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const dct = line("dct");
  await save("rep", c, { lines: [{ line_id: dct.id, amount: 12 }, { line_id: line("atf").id, amount: 5 }], total_l: 80 });
  await pool.query("UPDATE volume_potential_lines SET active = false WHERE id = $1", [dct.id]);
  try {
    // the sheet no longer shows DCT: a save without it keeps it, the active lines are replaced
    const r = await save("rep", c, { lines: [{ line_id: line("atf").id, amount: 7 }], total_l: null });
    assert.deepEqual(r.data.lines.map((l) => [l.line_id, l.amount]).sort((a, b) => a[0] - b[0]), [[line("atf").id, 7], [dct.id, 12]].sort((a, b) => a[0] - b[0]));
    assert.equal(r.data.total_l, 80, "a blank total leaves the monthly need");
  } finally {
    await pool.query("UPDATE volume_potential_lines SET active = true WHERE id = $1", [dct.id]);
  }
  // the director sets 200 now; a rep's save pressed 10 minutes ago arrives later: the need stays 200
  await save("director", c, { total_l: 200 });
  await save("rep", c, { total_l: 90, captured_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), client_ref: `vp-old-${Date.now()}` });
  assert.equal((await pool.query("SELECT expected_volume_l::float8 AS l FROM customers WHERE id = $1", [c.id])).rows[0].l, 200);
  // ... and the older save leaves the newer profile and lines too (Codex review): the history marks it superseded
  await save("director", c, { cars_per_month: 300, lines: [{ line_id: line("atf").id, amount: 40 }], total_l: 200 });
  const old = await save("rep", c, { cars_per_month: 5, lines: [{ line_id: line("atf").id, amount: 1 }], captured_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), client_ref: `vp-old2-${Date.now()}` });
  assert.equal(old.status, 200);
  assert.equal(old.data.superseded, true);
  assert.equal(old.data.profile.cars_per_month, 300);
  assert.equal(old.data.lines.find((l) => l.line_id === line("atf").id).amount, 40);
  const top = (await apiRequest(`/api/volume-potential/customers/${c.id}/history`, { cookie: cookies.rep })).data[0];
  assert.equal(top.after.superseded, true);
  // two offline saves synced in order: the second (made later on the phone) is applied, whatever time the first reached the server
  const t0 = Date.now();
  await save("rep", c, { cars_per_month: 11, captured_at: new Date(t0 + 60 * 1000).toISOString(), client_ref: `vp-a-${t0}` });
  const b = await save("rep", c, { cars_per_month: 22, captured_at: new Date(t0 + 2 * 60 * 1000).toISOString(), client_ref: `vp-b-${t0}` });
  assert.equal(b.data.superseded, undefined);
  assert.equal(b.data.profile.cars_per_month, 22);
  // a huge order number is clamped, not a server error
  const added = await apiRequest("/api/volume-potential/lines", { method: "POST", cookie: cookies.director, body: { name_en: "Big", name_hy: "Մեծ", sort_order: 1e12, active: false } });
  assert.equal(added.status, 201);
  await pool.query("DELETE FROM volume_potential_lines WHERE id = $1", [added.data.id]);
});
