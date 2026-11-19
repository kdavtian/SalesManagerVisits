// Check-in > Competitors (owner, 2026-11-19; field/competitorBrands.js, migration 215): per brand bottles / drum / not available; a rep
// adds a brand that is usable at once by them and waits for admin / CEO (the Requests card); approved = everyone's, denied = out of the
// list. Made-up brand names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiFormRequest, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { parseBrandStatus } from "../../src/field/routes/checkins.js";

const tag = `Zz${Date.now().toString(36)}`;
let rep, rep2, ceo, accountant, cookies = {}, customer;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  ceo = await createUser("ceo");
  accountant = await createUser("accountant");
  for (const [k, u] of Object.entries({ rep, rep2, ceo, accountant })) cookies[k] = await loginAs(u.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
});
test.after(async () => {
  await pool.query("DELETE FROM competitor_brands WHERE lower(name) LIKE lower($1)", [`${tag}%`]);
  await cleanupAll();
  await stopTestServer();
});

const list = async (who) => (await apiRequest("/api/competitor-brands", { cookie: cookies[who] })).data.brands;
const add = (who, name) => apiRequest("/api/competitor-brands", { method: "POST", cookie: cookies[who], body: { name } });

test("bottles and drum are separate; not available clears them and is never 'present'", () => {
  const keys = new Set(["mobil", "motul", "shell", "fuchs"]);
  const r = parseBrandStatus(
    JSON.stringify({
      competitors: ["fuchs"],
      competitor_packs: { mobil: ["bottle"], motul: ["drum", "bottle", "drum"], shell: ["none", "bottle"], fuchs: ["none"], nope: ["bottle"], zic: ["weird"] },
    }),
    keys
  );
  assert.deepEqual(r.competitor_packs, { mobil: ["bottle"], motul: ["bottle", "drum"], shell: ["none"], fuchs: ["none"] });
  assert.deepEqual(r.competitors.sort(), ["mobil", "motul"], "present = bottles or drum; 'not available' removes an old tick");
  // an old client (no packs) keeps working
  assert.deepEqual(parseBrandStatus(JSON.stringify({ competitors: ["mobil", "x"] }), keys), { competitors: ["mobil"] });
});

test("the seeded list; a rep adds a brand: usable now by them only, a duplicate is not asked twice, too short is refused", async () => {
  const seeded = await list("rep");
  assert.ok(["mobil", "motul", "russian_oil"].every((k) => seeded.some((b) => b.key === k && b.status === "approved")));
  assert.equal((await add("rep", "x")).status, 400);
  const r = await add("rep", `${tag} Oil`);
  assert.equal(r.status, 201);
  assert.equal(r.data.brand.status, "pending");
  assert.equal(r.data.brand.key, `${tag.toLowerCase()}_oil`);
  assert.ok((await list("rep")).some((b) => b.key === r.data.brand.key && b.status === "pending"), "the rep sees it at once");
  assert.ok(!(await list("rep2")).some((b) => b.key === r.data.brand.key), "another rep does not, yet");
  const again = await add("rep2", `${tag.toUpperCase()} OIL`);
  assert.deepEqual([again.status, again.data.created, again.data.brand.key], [200, false, r.data.brand.key]);

  // the rep's visit can record it
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["follow_up_required"]));
  form.set("brand_status", JSON.stringify({ competitor_packs: { [r.data.brand.key]: ["drum"], mobil: ["none"] } }));
  const visit = await apiFormRequest("/api/checkins", { form, cookie: cookies.rep });
  assert.equal(visit.status, 201, JSON.stringify(visit.data));
  trackCheckin(visit.data.id);
  assert.deepEqual(visit.data.brand_status.competitors, [r.data.brand.key]);
  assert.deepEqual(visit.data.brand_status.competitor_packs, { [r.data.brand.key]: ["drum"], mobil: ["none"] });
});

test("admin / CEO decide on the Requests card; a rep or the accountant cannot; deny needs a reason", async () => {
  const { data: { brand } } = await add("rep", `${tag} Lube`);
  for (const who of ["rep", "accountant"]) assert.equal((await apiRequest(`/api/competitor-brands/${brand.id}/approve`, { method: "POST", cookie: cookies[who] })).status, 403);
  // on the CEO's Requests list, with its card
  const items = (await apiRequest("/api/requests", { cookie: cookies.ceo })).data.items;
  assert.ok(items.some((i) => i.kind === "competitor_brand" && i.id === brand.id && i.extra === `${tag} Lube`));
  const card = await apiRequest(`/api/requests/competitor_brand/${brand.id}`, { cookie: cookies.ceo });
  assert.deepEqual([card.status, card.data.can_decide, card.data.details.name], [200, true, `${tag} Lube`]);
  assert.equal((await apiRequest(`/api/requests/competitor_brand/${brand.id}`, { cookie: cookies.rep2 })).status, 403, "another rep cannot open it");

  assert.equal((await apiRequest(`/api/competitor-brands/${brand.id}/deny`, { method: "POST", cookie: cookies.ceo, body: {} })).status, 400);
  assert.equal((await apiRequest(`/api/competitor-brands/${brand.id}/approve`, { method: "POST", cookie: cookies.ceo })).status, 200);
  assert.ok((await list("rep2")).some((b) => b.key === brand.key && b.status === "approved"), "approved: everyone's");
  assert.equal((await apiRequest(`/api/competitor-brands/${brand.id}/approve`, { method: "POST", cookie: cookies.ceo })).status, 409, "decided once");

  const { data: { brand: other } } = await add("rep", `${tag} Junk`);
  assert.equal((await apiRequest(`/api/competitor-brands/${other.id}/deny`, { method: "POST", cookie: cookies.ceo, body: { reason: "typo" } })).status, 200);
  assert.ok(!(await list("rep")).some((b) => b.key === other.key), "denied: out of the list, the asker's too");
});
