// The navigation roadmap's server parts (owner, 2026-11-04): pinned screens (GET/PUT /api/me/pins, checked against what the role may open),
// tap-to-screen timings (POST /api/perf/nav, checked and clipped; GET /api/perf/slow-screens admin only) and the one request for all badges
// (GET /api/badges: a rep gets only its own counts).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { cleanTimings } from "../../src/system/navTimings.js";
import { pinnableScreenIds, cleanPins, MAX_PINS } from "../../src/shared/screens.js";

let rep;
let admin;
let warehouse;
let cookies = {};
const userIds = [];

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  admin = await createUser("admin");
  warehouse = await createUser("warehouse_manager");
  userIds.push(rep.id, admin.id, warehouse.id);
  cookies = { rep: await loginAs(rep.email), admin: await loginAs(admin.email), warehouse: await loginAs(warehouse.email) };
});
test.after(async () => {
  await pool.query("DELETE FROM nav_timings WHERE route LIKE '#/itest-%'");
  await cleanupAll();
  await stopTestServer();
});

test("pins: a rep pins screens it may open, in order, at most 4", async () => {
  assert.equal((await apiRequest("/api/me/pins")).status, 401);
  const empty = await apiRequest("/api/me/pins", { cookie: cookies.rep });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.pins, []);
  assert.equal(empty.data.max, MAX_PINS);
  const saved = await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.rep, body: { pins: ["tab_customers", "qa_pricelist"] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.pins, ["tab_customers", "qa_pricelist"]);
  assert.deepEqual((await apiRequest("/api/me/pins", { cookie: cookies.rep })).data.pins, ["tab_customers", "qa_pricelist"]);
  const me = await apiRequest("/api/me", { cookie: cookies.rep });
  assert.deepEqual(me.data.pinned_screens, ["tab_customers", "qa_pricelist"]);
});

test("pins: a screen the role may not open, too many, or not a list -> 400; nothing changes", async () => {
  const cashflow = await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.rep, body: { pins: ["qa_cashflow"] } });
  assert.equal(cashflow.status, 400, "a rep does not see Cashflow");
  assert.deepEqual(cashflow.data.ids, ["qa_cashflow"]);
  assert.equal((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.rep, body: { pins: ["tab_map", "tab_orders", "tab_activity", "tab_customers", "qa_staff"] } })).status, 400);
  assert.equal((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.rep, body: { pins: "tab_map" } })).status, 400);
  assert.equal((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.rep, body: { pins: ["made_up"] } })).status, 400);
  assert.deepEqual((await apiRequest("/api/me/pins", { cookie: cookies.rep })).data.pins, ["tab_customers", "qa_pricelist"]);
  // the admin may pin Cashflow
  assert.equal((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.admin, body: { pins: ["qa_cashflow"] } })).status, 200);
  // the warehouse manager's own small app has every screen in its tabs: nothing to pin
  assert.equal((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.warehouse, body: { pins: ["tab_orders"] } })).status, 400);
  assert.deepEqual((await apiRequest("/api/me/pins", { method: "PUT", cookie: cookies.warehouse, body: { pins: [] } })).data.pins, []);
});

test("pins: shared rules (the same list the app offers)", () => {
  assert.ok(pinnableScreenIds("sales_manager", null).includes("tab_map"));
  assert.ok(!pinnableScreenIds("sales_manager", null).includes("qa_bank_desk"));
  assert.ok(pinnableScreenIds("accountant", null).includes("qa_bank_desk"));
  assert.ok(!pinnableScreenIds("admin", null).includes("qa_bonuses"), "Bonuses only while bonuses are on");
  assert.ok(pinnableScreenIds("admin", null, { bonusesEnabled: true }).includes("qa_bonuses"));
  // an admin who hid a tile for reps: a saved pin of it is dropped
  assert.ok(!pinnableScreenIds("sales_manager", { sales_manager: ["qa_check_in"] }).includes("qa_pricelist"));
  assert.deepEqual(cleanPins(["tab_map", "tab_map", "x", "qa_pricelist", "tab_orders", "tab_activity", "tab_customers"], pinnableScreenIds("sales_manager", null)), [
    "tab_map",
    "qa_pricelist",
    "tab_orders",
    "tab_activity",
  ]);
});

test("perf: timings are checked and clipped; ids never stored", () => {
  const rows = cleanTimings([
    { route: "#/customers/123?tab=2", ms: 412.4, kind: "nav" },
    { route: "javascript:alert(1)", ms: 10, kind: "nav" },
    { route: "#/orders", ms: -1, kind: "nav" },
    { route: "#/orders", ms: 99999, kind: "nav" },
    { route: "#/orders", ms: 250, kind: "other" },
    { route: "#/map", ms: 300, kind: "inp" },
  ]);
  assert.deepEqual(rows, [
    { route: "#/customers/:id", ms: 412, kind: "nav" },
    { route: "#/map", ms: 300, kind: "inp" },
  ]);
  assert.equal(cleanTimings(Array.from({ length: 100 }, () => ({ route: "#/a", ms: 1, kind: "nav" }))).length, 40);
});

test("perf: any signed-in app posts; a second batch within 20 s is refused; the report is the admin's", async () => {
  assert.equal((await apiRequest("/api/perf/nav", { method: "POST", body: { items: [] } })).status, 401);
  const items = [1, 2, 3, 4].map((i) => ({ route: "#/itest-perf", ms: 100 * i, kind: "nav" }));
  const ok = await apiRequest("/api/perf/nav", { method: "POST", cookie: cookies.rep, body: { items, device: "phone" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.stored, 4);
  assert.equal((await apiRequest("/api/perf/nav", { method: "POST", cookie: cookies.rep, body: { items } })).status, 429);
  assert.equal((await apiRequest("/api/perf/nav", { method: "POST", cookie: cookies.admin, body: { items: "x" } })).status, 400);
  assert.equal((await apiRequest("/api/perf/slow-screens", { cookie: cookies.rep })).status, 403);
  const report = await apiRequest("/api/perf/slow-screens?days=7", { cookie: cookies.admin });
  assert.equal(report.status, 200);
  const row = report.data.screens.find((r) => r.route === "#/itest-perf");
  assert.ok(row, JSON.stringify(report.data));
  assert.equal(row.samples, 4);
  assert.equal(row.p50, 250);
  const { rows } = await pool.query("SELECT role, device FROM nav_timings WHERE route = '#/itest-perf' LIMIT 1");
  assert.deepEqual(rows[0], { role: "sales_manager", device: "phone" });
});

test("badges: one request; a rep gets only the counts it may see", async () => {
  assert.equal((await apiRequest("/api/badges")).status, 401);
  const r = await apiRequest("/api/badges", { cookie: cookies.rep });
  assert.equal(r.status, 200);
  for (const key of ["orders", "payments", "unrecorded", "warehouse", "delivery", "notifications", "planApprovals", "editRequests", "accounting"]) {
    assert.equal(typeof r.data[key], "number", key);
  }
  // a rep confirms no orders, approves no plans, reviews no edit requests, records nothing: those stay 0 whatever waits in the database
  assert.equal(r.data.orders, 0);
  assert.equal(r.data.planApprovals, 0);
  assert.equal(r.data.editRequests, 0);
  assert.equal(r.data.unrecorded, 0);
  assert.equal(r.data.warehouse, 0);
});
