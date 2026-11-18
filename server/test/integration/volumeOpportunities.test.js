// Customer volume potential, phase 2 (customers/volumeActuals.js, volumeOpportunities.js): products sold are placed on product lines by the
// rules or by management; the last 3 whole months of ERP purchases (matched by Customer ID) against the potential give share of wallet and
// the gap; the Opportunities report ranks customers by the gap, management sees all, a rep only their own. Made-up products and customers.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { actualsWindow, autoLineCode, walletOf } from "../../src/customers/volumeActuals.js";

const tag = `vo${Date.now()}`;
let rep, rep2, director, cookies = {}, lines, big, small, others;
const line = (code) => lines.find((l) => l.code === code);
const sku = (s) => `${tag}-${s}`;
const day = (() => {
  const { from } = actualsWindow();
  return new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, 10)).toISOString().slice(0, 10); // inside the window
})();
const sell = (erpId, s, name, size, qty, d = day) =>
  pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, size_l, qty) VALUES ($1, $2, $3, $4, 'TestBrand', $5, $6, $7)",
    [erpId, `${tag}-o`, d, s, name, size, qty]
  );

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  for (const [k, u] of Object.entries({ rep, rep2, director })) cookies[k] = await loginAs(u.email);
  lines = (await apiRequest("/api/volume-potential/lines", { cookie: cookies.rep })).data.lines;
  big = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `${tag}-1` });
  small = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `${tag}-2` });
  others = await createCustomer({ created_by: rep2.id, assigned_manager_id: rep2.id, erp_customer_id: `${tag}-3` });
  // big: 30 x 4 L EDGE 5W-30 in the window = 40 L a month; a truck-or-car 15W-40 nobody placed yet; hydraulic oil (no line); one sale before
  // the window (not counted)
  await sell(big.erp_customer_id, sku("edge"), "EDGE 5W-30", "4", 30);
  await sell(big.erp_customer_id, sku("1540"), "Scooter 4T 15W-40", "5", 6);
  await sell(big.erp_customer_id, sku("hyd"), "Hyspin AWS 46", "20", 3);
  await sell(big.erp_customer_id, sku("edge"), "EDGE 5W-30", "4", 99, "2020-01-15");
  await pool.query(`INSERT INTO products (name, unit_price_amd, erp_product_id, family, brand) VALUES ('Hyspin AWS 46', 1, $1, 'Hydraulic', 'TestBrand')`, [sku("hyd")]);
  await sell(small.erp_customer_id, sku("atf"), "Transmax ATF Dexron", "1", 6);
  await sell(others.erp_customer_id, sku("edge"), "EDGE 5W-30", "4", 3);
  const put = (who, c, body) => apiRequest(`/api/volume-potential/customers/${c.id}`, { method: "PUT", cookie: cookies[who], body });
  await put("rep", big, { lines: [{ line_id: line("pcmo_5w30").id, amount: 100 }, { line_id: line("hdeo_15w40").id, amount: 50 }], total_l: 200 });
  await put("rep", small, { total_l: 20 });
  await put("rep2", others, { lines: [{ line_id: line("pcmo_5w30").id, amount: 30 }], total_l: 30 });
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE order_id = $1", [`${tag}-o`]);
  await pool.query("DELETE FROM volume_potential_sku_map WHERE sku_key LIKE $1", [`${tag}%`]);
  await pool.query("DELETE FROM products WHERE erp_product_id LIKE $1", [`${tag}%`]);
  await cleanupAll();
  await stopTestServer();
});

test("the rules: exact products map, unclear ones wait for a person", () => {
  assert.equal(autoLineCode({ name: "Castrol EDGE 5W-30 LL", family: "Edge" }).code, "pcmo_5w30");
  assert.equal(autoLineCode({ name: "Castrol VECTON 15W-40", family: "Vecton" }).code, "hdeo_15w40");
  assert.equal(autoLineCode({ name: "Castrol Transmax Manual EP 80W-90", family: "Transmission" }).code, "gear");
  assert.equal(autoLineCode({ name: "Castrol Transmax Universal", family: "Transmission" }).code, null);
  // owner's rule (2026-11-18): an engine oil is a car oil unless a truck / diesel word; a motorcycle oil stays for a person
  assert.equal(autoLineCode({ name: "Lotos 15W-40", family: "Engine Oil" }).code, "pcmo_15w40");
  assert.equal(autoLineCode({ name: "Lotos Turdus 15W-40", family: "Engine Oil" }).code, "hdeo_15w40");
  assert.equal(autoLineCode({ name: "Royal Diesel 10W-40 CI-4", family: "Engine Oil" }).code, "hdeo_10w40");
  assert.equal(autoLineCode({ name: "Castrol MAGNATEC 10W-40", family: "Magnatec" }).code, "pcmo_10w40", "a car range stays a car oil");
  assert.equal(autoLineCode({ name: "Some brake liquid", family: "Brake fluid" }).code, "brake");
  assert.equal(autoLineCode({ name: "Hyspin AWS 46", family: "Hydraulic" }).reason, "family_not_a_line");
  // never guessed (review): a 5W-40 of no known range, a motorcycle oil, a brake cleaner spray; an EV coolant is the EV line
  assert.equal(autoLineCode({ name: "Royal 5W-40", family: "Engine Oil" }).code, "pcmo_5w40");
  assert.equal(autoLineCode({ name: "Castrol POWER1 4T 5W-40", family: "Other" }).code, null);
  assert.equal(autoLineCode({ name: "Brake & parts cleaner spray", family: "Other" }).code, null);
  assert.equal(autoLineCode({ name: "Castrol Brake Fluid DOT 4", family: "Other" }).code, "brake");
  assert.equal(autoLineCode({ name: "Castrol ON EV Coolant", family: "ON" }).code, "ev_thermal");
});

test("grease (kg) never counts in litres: a grease-only customer has no litre potential unless kg lines alone are filtered", () => {
  const g = line("grease").id;
  const data = { lines: [{ line_id: g, amount: 100 }], total_l: null };
  const act = { by_line: { [g]: 40 }, total: 0, unmapped: 0 };
  assert.deepEqual([walletOf(data, act, { kgLines: new Set([g]) }).potential, walletOf(data, act, { kgLines: new Set([g]) }).gap], [0, 0]);
  const onlyKg = walletOf(data, act, { kgLines: new Set([g]), lineIds: new Set([g]) });
  assert.deepEqual([onlyKg.potential, onlyKg.actual, onlyKg.gap], [100, 40, 60]);
});

test("the card: actual litres a month per line from the last 3 whole months, share of wallet and gap", async () => {
  const r = await apiRequest(`/api/volume-potential/customers/${big.id}`, { cookie: cookies.rep });
  assert.equal(r.status, 200);
  const edge = line("pcmo_5w30").id;
  assert.equal(r.data.actuals.by_line[edge], 40, "30 x 4 L over 3 months; the 2020 sale is outside");
  assert.equal(r.data.actuals.unmapped, 10, "6 x 5 L of the unclear 15W-40 / 3");
  const w = r.data.wallet;
  assert.deepEqual(w.lines.find((l) => l.line_id === edge), { line_id: edge, potential: 100, actual: 40, share_pct: 40, gap: 60, kg: false });
  assert.deepEqual([w.potential, w.actual, w.gap, w.share_pct], [200, 40, 160, 20], "bought + can still buy = the whole potential; share = bought / potential");
  assert.equal(w.lines.find((l) => l.line_id === line("hdeo_15w40").id).gap, 50, "where: nothing placed on 15W-40 yet");
});

test("management places an unmapped product; it then counts; a rep cannot", async () => {
  const list = await apiRequest("/api/volume-potential/skus", { cookie: cookies.director });
  assert.equal(list.status, 200);
  assert.ok(list.data.skus.some((s) => s.sku_key === sku("1540") && s.status === "unmapped"));
  assert.ok(!list.data.skus.some((s) => s.sku_key === sku("hyd")), "hydraulic is no line, not unmapped");
  assert.ok(list.data.counts.unmapped >= 1);
  assert.equal((await apiRequest(`/api/volume-potential/skus/${encodeURIComponent(sku("1540"))}`, { method: "PUT", cookie: cookies.rep, body: { line_id: line("hdeo_15w40").id } })).status, 403);
  assert.equal((await apiRequest(`/api/volume-potential/skus/${encodeURIComponent(sku("1540"))}`, { method: "PUT", cookie: cookies.director, body: { line_id: 99999999 } })).status, 400);
  assert.equal((await apiRequest(`/api/volume-potential/skus/${encodeURIComponent(sku("1540"))}`, { method: "PUT", cookie: cookies.director, body: { line_id: line("hdeo_15w40").id } })).status, 200);
  const r = await apiRequest(`/api/volume-potential/customers/${big.id}`, { cookie: cookies.rep });
  assert.equal(r.data.actuals.by_line[line("hdeo_15w40").id], 10);
  assert.equal(r.data.actuals.unmapped, 0);
  assert.equal(r.data.wallet.gap, 150);
});

test("Opportunities: ranked by the gap; a rep sees only their own; filters by line and rep; totals by region and rep", async () => {
  const mine = (await apiRequest("/api/volume-potential/opportunities", { cookie: cookies.rep })).data;
  assert.deepEqual(mine.rows.map((r) => r.customer_id), [big.id, small.id], "own customers only, biggest gap first");
  const smallRow = mine.rows.find((r) => r.customer_id === small.id);
  assert.deepEqual([smallRow.potential, smallRow.actual, smallRow.gap, smallRow.by_lines], [20, 2, 18, false], "no breakdown: the total against all mapped litres");

  const all = (await apiRequest(`/api/volume-potential/opportunities?reps=${rep2.id}`, { cookie: cookies.director })).data;
  assert.deepEqual(all.rows.map((r) => r.customer_id), [others.id]);
  assert.deepEqual([all.rows[0].actual, all.rows[0].gap, all.rows[0].share_pct], [4, 26, 13]);
  assert.equal(all.by_rep[0].key, String(rep2.id));

  const byLine = (await apiRequest(`/api/volume-potential/opportunities?lines=${line("pcmo_5w30").id}&reps=${rep.id}`, { cookie: cookies.director })).data;
  assert.deepEqual(byLine.rows.map((r) => [r.customer_id, r.gap]), [[big.id, 60]], "only the 5W-30 gap; a customer with no breakdown drops out");
  assert.equal((await apiRequest("/api/volume-potential/opportunities", { cookie: await loginAs((await createUser("accountant")).email) })).status, 403);
});

test("bulk: management places several products at once (litres set by hand stay); a rep cannot; bad input is refused", async () => {
  const keys = [sku("bulk-a"), sku("bulk-b")];
  await pool.query("INSERT INTO volume_potential_sku_map (sku_key, litres_per_unit) VALUES ($1, 3)", [keys[0]]);
  const url = "/api/volume-potential/skus/bulk";
  assert.equal((await apiRequest(url, { method: "POST", cookie: cookies.rep, body: { keys, line_id: line("atf").id } })).status, 403);
  assert.equal((await apiRequest(url, { method: "POST", cookie: cookies.director, body: { keys: [], line_id: line("atf").id } })).status, 400);
  assert.equal((await apiRequest(url, { method: "POST", cookie: cookies.director, body: { keys, line_id: 99999999 } })).status, 400);
  const r = await apiRequest(url, { method: "POST", cookie: cookies.director, body: { keys, line_id: line("atf").id } });
  assert.deepEqual([r.status, r.data.saved], [200, 2]);
  const rows = (await pool.query("SELECT sku_key, line_id, not_a_line, litres_per_unit::float8 AS l FROM volume_potential_sku_map WHERE sku_key = ANY($1) ORDER BY sku_key", [keys])).rows;
  assert.deepEqual(rows.map((x) => [x.line_id, x.not_a_line, x.l]), [[line("atf").id, false, 3], [line("atf").id, false, null]]);
  assert.equal((await apiRequest(url, { method: "POST", cookie: cookies.director, body: { keys, not_a_line: true } })).data.saved, 2);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM volume_potential_sku_map WHERE sku_key = ANY($1) AND not_a_line AND line_id IS NULL", [keys])).rows[0].n, 2);
});

