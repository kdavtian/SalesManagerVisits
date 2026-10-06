// GET /api/customers/brand-summary: what check-ins recorded about the
// brands on a shop's shelf -- "current" carries each brand group forward
// from the latest visit that recorded it; "ever" is every value any visit
// recorded (Customers search/filter). Sales managers only see their own
// assigned customers.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, mgr, other, adminCookie, mgrCookie, mine, theirs;

async function addCheckin(customerId, userId, brandStatus, daysAgo) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status, outcomes, timestamp)
     VALUES ($1, $2, 40.18, 44.51, 10, true, $3, ARRAY['assortment_check'], now() - ($4 || ' days')::interval) RETURNING id`,
    [customerId, userId, brandStatus ? JSON.stringify(brandStatus) : null, String(daysAgo)]
  );
  trackCheckin(rows[0].id);
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  mgr = await createUser("sales_manager");
  other = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  mgrCookie = await loginAs(mgr.email);
  mine = await createCustomer({ created_by: mgr.id });
  theirs = await createCustomer({ created_by: other.id });

  // Oldest visit: fake Castrol + Lotos available + Mobil.
  await addCheckin(mine.id, mgr.id, { castrol: ["fake"], lotos: ["available"], competitors: ["mobil"] }, 30);
  // Newer visit updates Castrol only (now imported from the USA); records nothing about Lotos/competitors.
  await addCheckin(mine.id, mgr.id, { castrol: ["imported_us"] }, 10);
  // Newest visit records no brand info at all -- nothing should change.
  await addCheckin(mine.id, mgr.id, null, 1);
  await addCheckin(theirs.id, other.id, { castrol: ["fake"] }, 5);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("current carries each brand group forward from the latest visit that recorded it", async () => {
  const res = await apiRequest(`/api/customers/brand-summary?customer_id=${mine.id}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.length, 1);
  const { current } = res.data[0];
  assert.deepEqual(current.castrol.values, ["imported_us"]);
  assert.deepEqual(current.lotos.values, ["available"]);
  assert.deepEqual(current.competitors.values, ["mobil"]);
  assert.equal(current.royal, undefined);
});

test("ever lists every recorded value with its latest date, including superseded ones", async () => {
  const res = await apiRequest(`/api/customers/brand-summary?customer_id=${mine.id}`, { cookie: adminCookie });
  const ever = res.data[0].ever;
  const values = ever.map((e) => `${e.group}:${e.value}`).sort();
  assert.deepEqual(values, ["castrol:fake", "castrol:imported_us", "competitors:mobil", "lotos:available"]);
  const fake = ever.find((e) => e.value === "fake");
  const us = ever.find((e) => e.value === "imported_us");
  assert.ok(new Date(us.last_at) > new Date(fake.last_at));
});

test("a sales manager only sees their own assigned customers; admin sees all", async () => {
  const asMgr = await apiRequest("/api/customers/brand-summary", { cookie: mgrCookie });
  assert.equal(asMgr.status, 200);
  assert.ok(asMgr.data.some((r) => r.customer_id === mine.id));
  assert.ok(!asMgr.data.some((r) => r.customer_id === theirs.id));

  const asAdmin = await apiRequest("/api/customers/brand-summary", { cookie: adminCookie });
  assert.ok(asAdmin.data.some((r) => r.customer_id === theirs.id));
});

test("brand-summary requires login", async () => {
  const res = await apiRequest("/api/customers/brand-summary");
  assert.equal(res.status, 401);
});
