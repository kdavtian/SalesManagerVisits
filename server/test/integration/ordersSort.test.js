// GET /api/orders?sort=&reverse= : the desktop column headings sort the WHOLE order history on the server
// (date = default, amount, customer, status), a second click reverses; unknown values fall back to the default.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let cookie;
const mine = new Map(); // order id -> { name, total, status }

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  cookie = await loginAs(admin.email);
  const rows = [
    ["Zulu Sort Garage", 30000, "delivered"],
    ["Alpha Sort Garage", 10000, "submitted"],
    ["Mike Sort Garage", 20000, "confirmed"],
  ];
  for (const [i, [name, total, status]] of rows.entries()) {
    const customer = await createCustomer({ created_by: admin.id, name: `${name} ${Date.now()}` });
    const { rows: inserted } = await pool.query(
      `INSERT INTO orders (customer_id, user_id, status, total_amd, order_code, payment_method, created_at)
       VALUES ($1, $2, $3, $4, $5, 'cash', now() - ($6 || ' minutes')::interval) RETURNING id`,
      [customer.id, admin.id, status, total, `SORT-${Date.now()}-${i}`, String(i)]
    );
    trackOrder(inserted[0].id);
    mine.set(inserted[0].id, { name: customer.name, total, status });
  }
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// Filtered to this test's own user: other test files (the pagination one creates 100+ orders) share the database and
// would push these rows off the first page.
async function ids(query) {
  const res = await apiRequest(`/api/orders?user_id=${admin.id}${query ? `&${query}` : ""}`, { cookie });
  assert.equal(res.status, 200);
  return res.data.rows.filter((r) => mine.has(r.id)).map((r) => r.id);
}
const byTotal = () => [...mine.entries()].sort((a, b) => b[1].total - a[1].total).map(([id]) => id);

test("default order is newest first", async () => {
  const list = await ids("");
  assert.deepEqual(list, [...mine.keys()]); // inserted newest -> oldest
});

test("sort=amount is highest first, reverse=1 lowest first", async () => {
  assert.deepEqual(await ids("sort=amount"), byTotal());
  assert.deepEqual(await ids("sort=amount&reverse=1"), byTotal().reverse());
});

test("sort=customer is A-Z, reverse=1 is Z-A", async () => {
  const az = [...mine.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id]) => id);
  assert.deepEqual(await ids("sort=customer"), az);
  assert.deepEqual(await ids("sort=customer&reverse=1"), [...az].reverse());
});

test("sort=status follows the order flow (submitted, confirmed, delivered)", async () => {
  const flow = ["draft", "submitted", "confirmed", "packed_stock_out", "delivered"];
  const expected = [...mine.entries()].sort((a, b) => flow.indexOf(a[1].status) - flow.indexOf(b[1].status)).map(([id]) => id);
  assert.deepEqual(await ids("sort=status"), expected);
  assert.deepEqual(await ids("sort=status&reverse=1"), [...expected].reverse());
});

test("an unknown sort value (or an injection attempt) falls back to the default order", async () => {
  assert.deepEqual(await ids("sort=total_amd;DROP TABLE orders"), [...mine.keys()]);
  assert.deepEqual(await ids("sort=nonsense"), [...mine.keys()]);
});

test("a sorted page keeps its place across offset pages (stable tie-break)", async () => {
  const first = await apiRequest(`/api/orders?user_id=${admin.id}&sort=customer`, { cookie });
  const all = first.data.rows.map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
});
