// Owner, 2026-11-03: a rep's location ping is answered with the office he is standing at (so the app can offer the check-in).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, cookie, office, admin, adminCookie;
const AT = { lat: 40.1912, lng: 44.5121 };

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  cookie = await loginAs(rep.email);
  office = await createCustomer({ created_by: admin.id, ...AT });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("only an admin can make a place an office; a rep's edit request cannot", async () => {
  const asRep = await apiRequest(`/api/customers/${office.id}`, { method: "PATCH", cookie, body: { checkin_for_all: true } });
  assert.equal(asRep.status, 403);
  const bad = await apiRequest(`/api/customers/${office.id}`, { method: "PATCH", cookie: adminCookie, body: { checkin_for_all: "yes" } });
  assert.equal(bad.status, 400);
  const ok = await apiRequest(`/api/customers/${office.id}`, { method: "PATCH", cookie: adminCookie, body: { checkin_for_all: true } });
  assert.equal(ok.status, 200);
  const req = await apiRequest("/api/edit-requests", { method: "POST", cookie, body: { customer_id: office.id, changes: { checkin_for_all: false } } });
  assert.equal(req.status, 400); // nothing editable left in the request
});

test("the ping near the office names it; far away or right after a check-in it does not", async () => {
  const near = await apiRequest("/api/locations", { method: "POST", cookie, body: { lat: AT.lat + 0.0005, lng: AT.lng } });
  assert.equal(near.status, 200);
  assert.equal(near.data.office.id, office.id);
  assert.ok(near.data.office.distance_m < 150);
  const far = await apiRequest("/api/locations", { method: "POST", cookie, body: { lat: AT.lat + 0.01, lng: AT.lng } });
  assert.equal(far.data.office, null);
  const { rows } = await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, $3, $4, 5, true) RETURNING id", [office.id, rep.id, AT.lat, AT.lng]);
  trackCheckin(rows[0].id);
  const again = await apiRequest("/api/locations", { method: "POST", cookie, body: { lat: AT.lat, lng: AT.lng } });
  assert.equal(again.data.office, null);
});

test("a rep can open the office to check in (it is visible to everyone)", async () => {
  const r = await apiRequest(`/api/customers/${office.id}`, { cookie });
  assert.equal(r.status, 200);
});

test("the customer list a rep gets (the map's source) includes the office", async () => {
  const r = await apiRequest("/api/customers", { cookie });
  assert.equal(r.status, 200);
  const found = r.data.find((c) => c.id === office.id);
  assert.ok(found, "office is in the rep's list");
  assert.equal(found.checkin_for_all, true);
});
