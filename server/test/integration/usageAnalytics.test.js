// Owner, 2026-11-03: usage analytics behind an admin switch (OFF by default); screens without ids, time per screen, menu taps; admin-only report.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { pageKey } from "../../src/system/usageAnalytics.js";

let admin, rep, adminCookie, repCookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1)", [[admin.id, rep.id]]);
});
test.after(async () => {
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { usage_analytics_enabled: false } });
  await pool.query("DELETE FROM usage_events WHERE user_id = ANY($1)", [[admin.id, rep.id]]);
  await cleanupAll();
  await stopTestServer();
});

test("pageKey keeps the kind of screen, never an id or a search text", () => {
  assert.equal(pageKey("#/customers/123"), "#/customers/:id");
  assert.equal(pageKey("#/customers/123/orders?q=secret"), "#/customers/:id/orders");
  assert.equal(pageKey("#/map"), "#/map");
  assert.equal(pageKey("https://evil.example"), null);
  assert.equal(pageKey("#/a b"), null);
});

test("off by default: the app's batch is ignored and nothing is stored", async () => {
  const s = await apiRequest("/api/settings", { cookie: repCookie });
  assert.equal(s.data.usage_analytics_enabled, false);
  const r = await apiRequest("/api/usage/events", { method: "POST", cookie: repCookie, body: { events: [{ kind: "page", target: "#/map", seconds: 20 }] } });
  assert.equal(r.data.enabled, false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [rep.id])).rows[0].n, 0);
});

test("only the admin turns it on; then pages, time and taps are stored and the report totals them", async () => {
  const no = await apiRequest("/api/settings", { method: "PATCH", cookie: repCookie, body: { usage_analytics_enabled: true } });
  assert.ok([401, 403].includes(no.status));
  const on = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { usage_analytics_enabled: true } });
  assert.equal(on.data.usage_analytics_enabled, true);
  const events = [
    { kind: "page", target: "#/customers/55", seconds: 30 },
    { kind: "page", target: "#/customers/77", seconds: 50 },
    { kind: "page", target: "#/map", seconds: 5000 }, // capped at half an hour
    { kind: "page", target: "https://x.example", seconds: 9 }, // dropped
    { kind: "tap", target: "nav:#/orders" },
    { kind: "tap", target: "nav:#/orders" },
    { kind: "tap", target: "bad target with spaces" }, // dropped
  ];
  const r = await apiRequest("/api/usage/events", { method: "POST", cookie: repCookie, body: { events } });
  assert.equal(r.data.enabled, true);
  const rep403 = await apiRequest("/api/usage/report", { cookie: repCookie });
  assert.equal(rep403.status, 403);
  const rep1 = await apiRequest("/api/usage/report?days=30", { cookie: adminCookie });
  const customers = rep1.data.pages.find((p) => p.target === "#/customers/:id");
  assert.equal(customers.visits, 2);
  assert.equal(customers.total_seconds, 80);
  assert.equal(customers.avg_seconds, 40);
  assert.equal(rep1.data.pages.find((p) => p.target === "#/map").total_seconds, 1800);
  assert.equal(rep1.data.taps.find((t) => t.target === "nav:#/orders").taps, 2);
  assert.equal(rep1.data.pages.some((p) => p.target.includes("example")), false);
});
