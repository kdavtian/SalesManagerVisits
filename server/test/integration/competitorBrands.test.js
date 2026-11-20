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

// owner, 2026-11-20: a rep who could not look at the shelf says why; it is kept only when no shelf data was recorded with it
test("could not check the shelf: kept with its reason, dropped beside real shelf data or without a reason", () => {
  const keys = new Set(["mobil"]);
  assert.deepEqual(parseBrandStatus(JSON.stringify({ shelf_skipped: { reason: "  owner away  " } }), keys), { shelf_skipped: { reason: "owner away" } });
  assert.equal(parseBrandStatus(JSON.stringify({ shelf_skipped: { reason: "x" } }), keys), null, "a reason of 3+ letters");
  assert.deepEqual(parseBrandStatus(JSON.stringify({ castrol: ["available"], shelf_skipped: { reason: "owner away" } }), keys), { castrol: ["available"] });
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

test("review fixes: reserved and same-but-spaced names, two reps adding at once, all 'not available' clears the card's chips", async () => {
  assert.equal((await add("rep", "Constructor")).status, 400);
  assert.equal((await add("rep", "__proto__")).status, 400);
  const spaced = await add("rep", "Liqui Moly");
  assert.deepEqual([spaced.status, spaced.data.created, spaced.data.brand.key], [200, false, "liquimoly"], "the same brand whatever the spacing");
  const [a, b] = await Promise.all([add("rep", `${tag} Twin`), add("rep2", `${tag} Twin`)]);
  assert.deepEqual([a.status < 300, b.status < 300, a.data.brand.key === b.data.brand.key], [true, true, true], "no server error, one brand");
  assert.equal([a.data.created, b.data.created].filter(Boolean).length, 1);

  // a visit marks Mobil present, the next one marks it not available: the card's current competitors are empty (a shop of its own)
  const shop = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const post = async (bs, minutesAgo) => {
    const form = new FormData();
    form.set("customer_id", String(shop.id));
    form.set("lat", "40.18");
    form.set("lng", "44.51");
    form.set("outcomes", JSON.stringify(["follow_up_required"]));
    form.set("brand_status", JSON.stringify(bs));
    form.set("captured_at", new Date(Date.now() - minutesAgo * 60000).toISOString());
    const r = await apiFormRequest("/api/checkins", { form, cookie: cookies.rep });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    trackCheckin(r.data.id);
    return r;
  };
  await post({ competitor_packs: { mobil: ["bottle"] } }, 3);
  const last = await post({ competitor_packs: { mobil: ["none"] } }, 1);
  assert.deepEqual(last.data.brand_status.competitors, [], "an explicit empty list: this visit recorded the competitors");
  const summary = (await apiRequest(`/api/customers/brand-summary?customer_id=${shop.id}`, { cookie: cookies.rep })).data;
  const row = (Array.isArray(summary) ? summary : summary.rows ?? []).find((r) => r.customer_id === shop.id);
  assert.deepEqual(row.current.competitors.values, [], "Mobil is no longer 'current'");
});

test("per product line: bottles / drum / not available and the prices per volume; everyone reads the latest", async () => {
  const shop = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const form = new FormData();
  form.set("customer_id", String(shop.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["follow_up_required"]));
  form.set("brand_status", JSON.stringify({ competitor_line_packs: { motul: { pcmo_5w30: ["bottle"], atf: ["none"], nope_line: ["drum"] }, nope_brand: { atf: ["drum"] } } }));
  form.set(
    "competitor_prices",
    JSON.stringify([
      { brand: "motul", line: "pcmo_5w30", volume: 4, wholesale: "12 500", retail: 15000 },
      { brand: "motul", line: "pcmo_5w30", volume: 208, wholesale: 520000 },
      { brand: "motul", line: "pcmo_5w30", volume: 20, retail: 60000 }, // a custom volume
      { brand: "motul", line: "pcmo_5w30", volume: 1 }, // no price: dropped
      { brand: "motul", line: "nope", volume: 1, retail: 5 }, // unknown line: dropped
      { brand: "x_none", line: "atf", volume: 1, retail: 5 }, // unknown brand: dropped
      { brand: "motul", line: "atf", volume: -1, retail: 5 }, // bad volume: dropped
    ])
  );
  const r = await apiFormRequest("/api/checkins", { form, cookie: cookies.rep });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackCheckin(r.data.id);
  assert.deepEqual(r.data.brand_status.competitor_line_packs, { motul: { pcmo_5w30: ["bottle"], atf: ["none"] } });
  assert.deepEqual(r.data.brand_status.competitors, ["motul"], "a line with bottles makes its brand present");
  // a brand marked "not available" is never made present by its lines
  const { parseBrandStatus } = await import("../../src/field/routes/checkins.js");
  const both = parseBrandStatus(JSON.stringify({ competitor_packs: { motul: ["none"] }, competitor_line_packs: { motul: { pcmo_5w30: ["bottle"] } } }), new Set(["motul"]), new Set(["pcmo_5w30"]));
  assert.deepEqual(both.competitors, []);
  const { rows } = await pool.query("SELECT line_code, volume::float8 AS v, wholesale_amd, retail_amd FROM competitor_prices WHERE checkin_id = $1 ORDER BY volume", [r.data.id]);
  assert.deepEqual(rows.map((x) => [x.line_code, x.v, x.wholesale_amd, x.retail_amd]), [["pcmo_5w30", 4, 12500, 15000], ["pcmo_5w30", 20, null, 60000], ["pcmo_5w30", 208, 520000, null]]);
  // another rep sees the latest
  const latest = (await apiRequest("/api/competitor-brands/motul/prices", { cookie: cookies.rep2 })).data.prices;
  assert.equal(latest.pcmo_5w30[4].retail, 15000);
  assert.equal(latest.pcmo_5w30[208].wholesale, 520000);
});

test("viscosity: filled from the name by the database, typed by management stays, emptied comes back from the name", async () => {
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const { rows: [p] } = await pool.query("INSERT INTO products (name, unit_price_amd, brand) VALUES ($1, 1, 'TestBrand') RETURNING id, viscosity", [`${tag} EDGE 5w30 LL`]);
  try {
    assert.equal(p.viscosity, "5W-30");
    const typed = await apiRequest(`/api/products/${p.id}`, { method: "PATCH", cookie, body: { viscosity: "0w-20" } });
    assert.deepEqual([typed.status, typed.data.viscosity, typed.data.viscosity_manual], [200, "0W-20", true]);
    await pool.query("UPDATE products SET name = $2 WHERE id = $1", [p.id, `${tag} EDGE 10W-40`]);
    assert.equal((await pool.query("SELECT viscosity FROM products WHERE id = $1", [p.id])).rows[0].viscosity, "0W-20", "typed: kept when the name changes");
    const back = await apiRequest(`/api/products/${p.id}`, { method: "PATCH", cookie, body: { viscosity: "" } });
    assert.deepEqual([back.data.viscosity, back.data.viscosity_manual], ["10W-40", false]);
    const { rows: [n] } = await pool.query("INSERT INTO products (name, unit_price_amd) VALUES ($1, 1) RETURNING viscosity", [`${tag} Radicool NF`]);
    assert.equal(n.viscosity, null);
    const { rows: [z] } = await pool.query("INSERT INTO products (name, unit_price_amd) VALUES ($1, 1) RETURNING viscosity", [`${tag} Oil 05W-30`]);
    assert.equal(z.viscosity, "5W-30", "a leading zero is dropped");
    // a grade inside a code is not a grade; one on its own is (migration 217)
    const visc = async (name) => (await pool.query("SELECT viscosity_of_name($1) AS v", [name])).rows[0].v;
    assert.equal(await visc("Zz3w2k EDGE 5W-30"), "5W-30");
    assert.equal(await visc("MAGNATEC 10W40 A3/B4"), "10W-40");
    assert.equal(await visc("Edge 0W20"), "0W-20");
    assert.equal(await visc("AB3W2 filter"), null);
    assert.equal(await visc("15W400X"), null);
    assert.equal((await apiRequest(`/api/products/${p.id}`, { method: "PATCH", cookie, body: { viscosity: "SAE 40" } })).status, 400, "only like 5W-30");
  } finally {
    await pool.query("DELETE FROM products WHERE name LIKE $1", [`${tag}%`]);
  }
});
