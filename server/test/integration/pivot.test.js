// The Pivot report (owner, 2026-11-03): admin and CEO only (never widened by the report settings), any field of any source on rows /
// columns / values with true totals, a list of chosen fields (every shop with fake Castrol, its address and manager), filters with
// values as parameters only, saved views (private / shared) and Excel / PDF export.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { buildMatrix } from "../../../client/public/js/shared/pivotMatrix.js";

let users, cookies, shops;
const stamp = Date.now().toString(36);

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "ceo", "sales_director", "accountant", "sales_manager"]) {
    users[role] = await createUser(role, { name: `ITest PV ${role} ${stamp}` });
    cookies[role] = await loginAs(users[role].email);
  }
  shops = [];
  for (const [i, sub] of [["A", "Abovyan"], ["B", "Abovyan"], ["C", "Hrazdan"]].entries()) {
    const c = await createCustomer({ created_by: users.admin.id, assigned_manager_id: users.sales_manager.id, name: `ITest PV Shop ${sub[0]} ${stamp}` });
    await pool.query("UPDATE customers SET region = 'Kotayk', subregion = $2, address = $3 WHERE id = $1", [c.id, sub[1], `Street ${i + 1}`]);
    shops.push(c.id);
  }
  // shelf records: shop A had fake Castrol, then a later visit found it gone; shop B still has it
  const visit = (cid, status, daysAgo) =>
    pool.query("INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, brand_status) VALUES ($1, $2, now() - ($3 || ' days')::interval, 40.2, 44.5, 5, true, $4)", [cid, users.sales_manager.id, daysAgo, JSON.stringify(status)]);
  await visit(shops[0], { castrol: ["fake"] }, 10);
  await visit(shops[0], { castrol: ["available"] }, 2);
  await visit(shops[1], { castrol: ["fake", "imported_us"], competitors: ["mobil"] }, 3);
});
test.after(async () => {
  await pool.query("DELETE FROM checkins WHERE customer_id = ANY($1)", [shops]);
  await pool.query("DELETE FROM pivot_views WHERE owner_id = ANY($1)", [Object.values(users).map((u) => u.id)]);
  await pool.query("DELETE FROM report_access WHERE report_key = 'pivot'");
  await cleanupAll();
  await stopTestServer();
});

const run = (role, spec) => apiRequest("/api/pivot/run", { method: "POST", cookie: cookies[role], body: { spec } });

test("only admin and the CEO: others get 403 even when the report settings try to widen it", async () => {
  assert.equal((await apiRequest("/api/pivot/sources", { cookie: cookies.ceo })).status, 200);
  for (const role of ["sales_director", "accountant", "sales_manager"]) assert.equal((await apiRequest("/api/pivot/sources", { cookie: cookies[role] })).status, 403, role);
  await apiRequest("/api/reports/access", { method: "PUT", cookie: cookies.admin, body: { report_key: "pivot", role: "sales_director", enabled: true } });
  const list = await apiRequest("/api/reports", { cookie: cookies.sales_director });
  assert.ok(!list.data.some((r) => r.key === "pivot"), "not offered to the sales director");
  assert.ok((await apiRequest("/api/reports", { cookie: cookies.ceo })).data.some((r) => r.key === "pivot"));
  assert.equal((await run("sales_director", { source: "customers", rows: [{ field: "rep" }] })).status, 403);
});

test("List: every shop that has fake Castrol NOW, with address and manager (an older visit's finding does not count)", async () => {
  const r = await run("ceo", {
    source: "shop_products",
    mode: "list",
    fields: ["cust_name", "cust_address", "cust_rep", "product"],
    filters: [{ field: "product", op: "in", value: ["castrol:fake"] }, { field: "current", op: "in", value: ["true"] }, { field: "cust_name", op: "contains", value: stamp }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // shop A: fake Castrol 10 days ago, gone at the latest visit -> only shop B (Street 2) has it now
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.rows[0][1], "Street 2");
  assert.equal(r.data.rows[0][2], users.sales_manager.name);
  // the history (every visit) shows both shops
  const history = await run("ceo", { source: "shop_products", mode: "list", fields: ["cust_name"], filters: [{ field: "product", op: "in", value: ["castrol:fake"] }, { field: "cust_name", op: "contains", value: stamp }] });
  assert.equal(history.data.rows.length, 2);
});

test("Pivot: shops by subregion x product with true totals (a distinct count is not the sum of its parts)", async () => {
  const r = await run("admin", {
    source: "shop_products",
    rows: [{ field: "cust_subregion" }],
    cols: [{ field: "group" }],
    values: [{ field: "cust_name", agg: "count_distinct" }, { field: "*", agg: "count" }],
    filters: [{ field: "cust_name", op: "contains", value: stamp }, { field: "current", op: "in", value: ["true"] }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = buildMatrix(r.data);
  assert.deepEqual(m.rowKeys, [["Abovyan"]]);
  assert.deepEqual(m.colKeys, [["castrol"], ["competitors"]]);
  assert.deepEqual(m.cell(["Abovyan"], ["castrol"]), [2, 3], "2 shops, 3 findings (A: available; B: fake, imported)");
  assert.deepEqual(m.cell(["Abovyan"], ["competitors"]), [1, 1]);
  assert.deepEqual(m.rowTotal(["Abovyan"]), [2, 4], "2 distinct shops in all, not 2 + 1");
  assert.deepEqual(m.grand, [2, 4]);
});

test("customers: live debt and date grouping work; a field or operator that does not exist is refused; values are never SQL", async () => {
  const r = await run("ceo", {
    source: "customers",
    rows: [{ field: "rep" }],
    cols: [{ field: "created", bucket: "month" }],
    values: [{ field: "*", agg: "count" }, { field: "live_debt", agg: "sum" }],
    filters: [{ field: "name", op: "contains", value: stamp }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(buildMatrix(r.data).grand[0], 3);
  assert.equal((await run("ceo", { source: "customers", rows: [{ field: "name; DROP TABLE users" }] })).status, 400);
  assert.equal((await run("ceo", { source: "customers", rows: [{ field: "rep" }], filters: [{ field: "rep", op: "evil" }] })).status, 400);
  assert.equal((await run("ceo", { source: "nope" })).status, 400);
  const quote = await run("ceo", { source: "customers", mode: "list", fields: ["name"], filters: [{ field: "name", op: "in", value: ["x' OR '1'='1"] }] });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.rows.length, 0);
  const values = await apiRequest("/api/pivot/values", { method: "POST", cookie: cookies.ceo, body: { spec: { source: "customers" }, field: "subregion", q: "abov" } });
  assert.ok(values.data.values.some((v) => v.v === "Abovyan" && v.n >= 2));
});

test("saved views: private to the owner until shared; the owner (or admin) changes or deletes it", async () => {
  const config = { source: "customers", mode: "pivot", rows: [{ field: "rep" }], values: [{ field: "*", agg: "count" }], filters: [] };
  const made = await apiRequest("/api/pivot/views", { method: "POST", cookie: cookies.ceo, body: { name: "ITest by rep", config } });
  assert.equal(made.status, 201);
  const id = made.data.view.id;
  const seenBy = async (role) => (await apiRequest("/api/pivot/views", { cookie: cookies[role] })).data.views.some((v) => v.id === id);
  assert.equal(await seenBy("admin"), false, "private");
  assert.equal((await apiRequest(`/api/pivot/views/${id}`, { method: "PATCH", cookie: cookies.ceo, body: { shared: true } })).status, 200);
  assert.equal(await seenBy("admin"), true, "shared");
  const adminView = await apiRequest("/api/pivot/views", { method: "POST", cookie: cookies.admin, body: { name: "ITest admin", config, shared: true } });
  assert.equal((await apiRequest(`/api/pivot/views/${adminView.data.view.id}`, { method: "PATCH", cookie: cookies.ceo, body: { name: "x" } })).status, 403, "not the CEO's");
  assert.equal((await apiRequest(`/api/pivot/views/${id}`, { method: "DELETE", cookie: cookies.admin })).status, 200, "admin may tidy up");
  assert.equal((await apiRequest("/api/pivot/views", { method: "POST", cookie: cookies.ceo, body: { name: "", config } })).status, 400);
});

test("export: Excel and PDF of the table the screen shows (Armenian text)", async () => {
  const body = { title: "Փորձ", header: ["Մենեջեր", "Քանակ"], rows: [["Արտակ", 3], ["Դավիթ", 5]], total: ["Ընդամենը", 8], numeric: [false, true] };
  for (const [format, magic] of [["xlsx", "PK"], ["pdf", "%PDF"]]) {
    const r = await apiRequest("/api/pivot/export", { method: "POST", cookie: cookies.ceo, body: { ...body, format } });
    assert.equal(r.status, 200, format);
    assert.ok(String(r.data).startsWith(magic), `${format} file`);
  }
  assert.equal((await apiRequest("/api/pivot/export", { method: "POST", cookie: cookies.accountant, body: { ...body, format: "xlsx" } })).status, 403);
});
