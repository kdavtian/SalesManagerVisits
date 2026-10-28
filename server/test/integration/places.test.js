// Armenian places (owner, 2026-10-25): spelling autocorrect of a customer's region / subregion, the review list, places added by "keep as typed".
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs, trackCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { resolvePlaces, searchPlaces } from "../../src/customers/places.js";

test.before(async () => {
  await startTestServer();
});
test.after(async () => {
  await pool.query("DELETE FROM custom_places WHERE lower(name_en) = 'zzyzx qwerty'");
  await cleanupAll();
  await stopTestServer();
});

test("places: the same name in Armenian, Russian and English spellings ends up as one English name, with its marz", () => {
  for (const typed of ["Gumri", "Գյումրի", "Гюմри", "gyumri"]) {
    const r = resolvePlaces({ subregion: typed });
    assert.equal(r.subregion, "Gyumri", typed);
    assert.equal(r.region, "Shirak", typed);
  }
  assert.equal(resolvePlaces({ region: "Shirak marz" }).region, "Shirak");
  assert.equal(resolvePlaces({ region: "Շիրակի մարզ" }).region, "Shirak");
  assert.deepEqual([resolvePlaces({ region: "yerevan", subregion: "Davitashen" }).region, resolvePlaces({ region: "yerevan", subregion: "Davitashen" }).subregion], ["Yerevan", "Davtashen"]);
  assert.equal(resolvePlaces({ region: "Yerevan", subregion: "kanaker zeytun" }).subregion, "Kanaker-Zeytun");
  assert.equal(resolvePlaces({ region: "Armavir", subregion: "Ejmiatsin" }).subregion, "Vagharshapat");
});

test("places: a one-letter typo is corrected and logged as 'near'; an unknown text stays as typed with a flag", () => {
  const near = resolvePlaces({ region: "Lori", subregion: "Vanadzr" });
  assert.equal(near.subregion, "Vanadzor");
  assert.equal(near.changed.find((c) => c.field === "subregion").how, "near");
  const unknown = resolvePlaces({ region: "Shirak", subregion: "Some Unknown Village" });
  assert.equal(unknown.subregion, "Some Unknown Village");
  assert.equal(unknown.unknown[0].field, "subregion");
  // a place of another marz keeps the chosen marz but is flagged
  const other = resolvePlaces({ region: "Ararat", subregion: "Dilijan" });
  assert.equal(other.region, "Ararat");
  assert.equal(other.unknown[0].reason, "other_region");
});

test("places: search finds by Armenian and English and respects the marz", () => {
  assert.ok(searchPlaces("gyum").some((p) => p.en === "Gyumri"));
  assert.ok(searchPlaces("Գյում").some((p) => p.en === "Gyumri"));
  assert.ok(searchPlaces("ab", { region: "Kotayk" }).every((p) => p.region === "Kotayk"));
});

test("places: saving a customer corrects the spelling, queues what it cannot place, and an admin can review it", async () => {
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const created = await apiRequest("/api/customers", { method: "POST", cookie, body: { name: `Place Test ${Date.now()}`, lat: 40.18, lng: 44.5, region: "shirak", subregion: "Gumri" } });
  assert.equal(created.status, 201);
  trackCustomer(created.data.id);
  assert.equal(created.data.region, "Shirak");
  assert.equal(created.data.subregion, "Gyumri");
  assert.ok(created.data.place_notice.changed.length > 0);

  // unknown text is kept as typed and queued
  const patched = await apiRequest(`/api/customers/${created.data.id}`, { method: "PATCH", cookie, body: { region: "Shirak", subregion: "Zzyzx Qwerty" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.subregion, "Zzyzx Qwerty");
  const reviews = await apiRequest("/api/places/reviews", { cookie });
  const mine = reviews.data.find((r) => r.customer_id === created.data.id);
  assert.ok(mine, "queued for review");
  assert.equal(mine.kind, "unknown");

  // "keep" adds it to the places; the same text then matches without a flag
  const kept = await apiRequest(`/api/places/reviews/${mine.id}/resolve`, { method: "POST", cookie, body: { action: "keep", name_hy: "Զզիզքս" } });
  assert.equal(kept.status, 200);
  const again = await apiRequest("/api/places/resolve", { method: "POST", cookie, body: { region: "Shirak", subregion: "zzyzx qwerty" } });
  assert.equal(again.data.unknown.length, 0);
  assert.equal(again.data.subregion, "Zzyzx Qwerty");

  // a sales rep cannot open the review list
  const rep = await createUser("sales_manager");
  const repCookie = await loginAs(rep.email);
  assert.equal((await apiRequest("/api/places/reviews", { cookie: repCookie })).status, 403);
  // ... but can search places
  assert.equal((await apiRequest("/api/places/search?q=gyum", { cookie: repCookie })).data.some((p) => p.en === "Gyumri"), true);

  // fixing the text by editing closes a pending review by itself
  await apiRequest(`/api/customers/${created.data.id}`, { method: "PATCH", cookie, body: { subregion: "Zzyzx Qwerty" } });
  const fixed = await apiRequest(`/api/customers/${created.data.id}`, { method: "PATCH", cookie, body: { subregion: "Gyumri" } });
  assert.equal(fixed.data.subregion, "Gyumri");
  const left = await pool.query("SELECT 1 FROM place_reviews WHERE customer_id = $1 AND status = 'pending'", [created.data.id]);
  assert.equal(left.rowCount, 0);
});

test("places: the cleanup renames old spellings in the customers and in the visit plan areas", async () => {
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const created = await apiRequest("/api/customers", { method: "POST", cookie, body: { name: `Cleanup Test ${Date.now()}`, lat: 40.7, lng: 43.8, region: "Shirak", subregion: "Gyumri" } });
  trackCustomer(created.data.id);
  // an old spelling written straight to the table (as the Excel sync and old app versions did)
  await pool.query("UPDATE customers SET subregion = 'Gumri' WHERE id = $1", [created.data.id]);
  const { rows: rule } = await pool.query(
    "INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, 3, $2, '{}', $1, false) RETURNING id",
    [admin.id, JSON.stringify([{ region: "Shirak", subregion: "Gumri" }])]
  );
  try {
    const plan = await apiRequest("/api/places/cleanup", { cookie });
    assert.ok(plan.data.changes.some((c) => c.from.subregion === "Gumri" && c.to.subregion === "Gyumri"));
    const applied = await apiRequest("/api/places/cleanup/apply", { method: "POST", cookie });
    assert.equal(applied.status, 200);
    const { rows } = await pool.query("SELECT subregion FROM customers WHERE id = $1", [created.data.id]);
    assert.equal(rows[0].subregion, "Gyumri");
    const { rows: areas } = await pool.query("SELECT areas FROM visit_plan_rules WHERE id = $1", [rule[0].id]);
    assert.equal(areas[0].areas[0].subregion, "Gyumri");
  } finally {
    await pool.query("DELETE FROM visit_plan_rules WHERE id = $1", [rule[0].id]);
  }
});
