// Owner, 2026-11-07: Cashflow categories as IN / OUT / Transfer -> category -> subcategory, managed by the admin; removing one moves its
// rows (and subcategories) to a chosen category and its Excel name keeps landing there. Isolated: it imports the Excel ledger.
process.env.ERP_SYNC_KEY = "itest-sync-key";
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let adminCookie, accCookie;
test.before(async () => {
  await startTestServer();
  adminCookie = await loginAs((await createUser("admin")).email);
  accCookie = await loginAs((await createUser("accountant")).email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const meta = async () => (await apiRequest("/api/cashflow/meta", { cookie: adminCookie })).data;
const byName = (m, n) => m.categories.find((c) => c.name.toLowerCase() === n.toLowerCase());

test("the migration puts the Excel names under their categories with a direction and a section", async () => {
  const m = await meta();
  assert.equal(m.can_manage_categories, true);
  const group = (leaf) => m.categories.find((c) => c.id === byName(m, leaf).parent_id);
  assert.equal(group("Oil order").name, "Customer payments");
  assert.equal(group("Oil order").direction, "in");
  assert.equal(group("Fuel").name, "Running costs");
  assert.equal(group("PPE").section, "investing");
  assert.equal(group("To bank").direction, "transfer");
  assert.equal(byName(m, "Divident").section, "owner");
});

test("admin adds a category and a subcategory; the accountant cannot manage the tree; the app's own names are kept", async () => {
  const g = await apiRequest("/api/cashflow/categories", { method: "POST", cookie: adminCookie, body: { name: "ITest Rent", is_group: true, direction: "out", section: "operating", note: "premises" } });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  const sub = await apiRequest("/api/cashflow/categories", { method: "POST", cookie: accCookie, body: { name: "ITest Office rent", parent_id: g.data.id } });
  assert.equal(sub.status, 201, "a subcategory can be added from the Add form");
  assert.equal((await apiRequest("/api/cashflow/categories", { method: "POST", cookie: accCookie, body: { name: "ITest Group 2", is_group: true, direction: "in" } })).status, 403);
  assert.equal((await apiRequest(`/api/cashflow/categories/${g.data.id}`, { method: "PATCH", cookie: accCookie, body: { note: "x" } })).status, 403);
  const m = await meta();
  const leaf = byName(m, "ITest Office rent");
  assert.equal(leaf.kind, "expense");
  assert.equal(leaf.direction, "out");
  const oil = byName(m, "Oil order");
  assert.equal((await apiRequest(`/api/cashflow/categories/${oil.id}`, { method: "PATCH", cookie: adminCookie, body: { name: "Customer money" } })).data.code, "system_category");
  assert.equal((await apiRequest(`/api/cashflow/categories/${oil.id}`, { method: "DELETE", cookie: adminCookie, body: {} })).data.code, "system_category");
});

test("removing a category with rows asks where they go, moves them, and its Excel name lands there afterwards", async () => {
  const m = await meta();
  const target = byName(m, "ITest Office rent");
  const acc = m.accounts[0] ?? (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ('ITest Cash', 'cash') RETURNING id")).rows[0];
  const old = await apiRequest("/api/cashflow/categories", { method: "POST", cookie: adminCookie, body: { name: "ITest Rent old", parent_id: byName(m, "ITest Rent").id } });
  await pool.query("INSERT INTO cash_entries (entry_date, amount, currency, amount_amd, category_id, account_id, origin) VALUES ('2026-01-05', -1000, 'AMD', -1000, $1, $2, 'manual')", [old.data.id, acc.id]);
  const ask = await apiRequest(`/api/cashflow/categories/${old.data.id}`, { method: "DELETE", cookie: adminCookie, body: {} });
  assert.equal(ask.status, 400);
  assert.equal(ask.data.code, "move_to_required");
  const del = await apiRequest(`/api/cashflow/categories/${old.data.id}`, { method: "DELETE", cookie: adminCookie, body: { move_to: target.id } });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_entries WHERE category_id = $1", [target.id])).rows[0].n, 1);
  // the Excel still writes the old name: its rows go to the new place, no new category is made
  const sync = await apiRequest("/api/erp-sync/cashflow-ledger", {
    method: "POST",
    headers: { "X-Sync-Key": "itest-sync-key" },
    body: { rows: [{ date: "2026-01-06", amount: -500, currency: "AMD", for: "ITest Rent old", source: acc.name ?? "ITest Cash", amount_amd: -500 }] },
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.categories_added, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_entries WHERE category_id = $1 AND origin = 'excel'", [target.id])).rows[0].n, 1);
  // a renamed subcategory keeps its old Excel name too, and moving it to another category carries its direction
  await apiRequest(`/api/cashflow/categories/${target.id}`, { method: "PATCH", cookie: adminCookie, body: { name: "ITest Rent of office", parent_id: byName(m, "Transfers between accounts").id } });
  const after = byName(await meta(), "ITest Rent of office");
  assert.equal(after.direction, "transfer");
  assert.equal(after.kind, "internal");
  assert.equal((await pool.query("SELECT category_id FROM cash_category_aliases WHERE name = 'itest office rent'")).rows[0].category_id, target.id);
});

test("a group with subcategories moves them to another group when it is removed", async () => {
  const m = await meta();
  const g = await apiRequest("/api/cashflow/categories", { method: "POST", cookie: adminCookie, body: { name: "ITest Temp group", is_group: true, direction: "out", section: "operating" } });
  await apiRequest("/api/cashflow/categories", { method: "POST", cookie: adminCookie, body: { name: "ITest Temp sub", parent_id: g.data.id } });
  const toLeaf = await apiRequest(`/api/cashflow/categories/${g.data.id}`, { method: "DELETE", cookie: adminCookie, body: { move_to: byName(m, "Fuel").id } });
  assert.equal(toLeaf.data.code, "group_required");
  const ok = await apiRequest(`/api/cashflow/categories/${g.data.id}`, { method: "DELETE", cookie: adminCookie, body: { move_to: byName(m, "Running costs").id } });
  assert.equal(ok.status, 200);
  assert.equal(byName(await meta(), "ITest Temp sub").parent_id, byName(m, "Running costs").id);
});
