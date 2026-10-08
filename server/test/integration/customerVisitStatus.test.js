// Visit-status columns (last visit, visited today/this week, overdue) come from
// one lateral aggregate shared by the customer list, its visited= filters and
// the single-customer card.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let cookie;
let visited;
let neverVisited;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  cookie = await loginAs(admin.email);
  visited = await createCustomer({ created_by: admin.id });
  neverVisited = await createCustomer({ created_by: admin.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now(), 40.1, 44.5, 5, true), ($1, $2, now() - interval '30 days', 40.1, 44.5, 5, true)`,
    [visited.id, admin.id]
  );
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("single customer card and list agree on last visit / visited today / overdue", async () => {
  const card = await apiRequest(`/api/customers/${visited.id}`, { cookie });
  assert.equal(card.status, 200);
  assert.equal(card.data.visited_today, true);
  assert.equal(card.data.visited_this_week, true);
  assert.equal(card.data.overdue, false);
  assert.ok(card.data.last_visit_at);

  const list = await apiRequest("/api/customers", { cookie });
  const row = list.data.find((c) => c.id === visited.id);
  assert.equal(row.visited_today, true);
  assert.equal(new Date(row.last_visit_at).getTime(), new Date(card.data.last_visit_at).getTime());

  const never = list.data.find((c) => c.id === neverVisited.id);
  assert.equal(never.visited_today, false);
  assert.equal(never.last_visit_at, null);
});

test("visited= filters use the same facts", async () => {
  const ids = async (visitedParam) => (await apiRequest(`/api/customers?visited=${visitedParam}`, { cookie })).data.map((c) => c.id);
  assert.ok((await ids("visited")).includes(visited.id));
  assert.ok(!(await ids("visited")).includes(neverVisited.id));
  assert.ok((await ids("not_visited")).includes(neverVisited.id));
  assert.ok(!(await ids("not_visited")).includes(visited.id));
});
