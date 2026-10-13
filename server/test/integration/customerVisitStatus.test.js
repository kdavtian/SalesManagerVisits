// Visit-status columns (last visit, visited today/this week, overdue) come from
// one lateral aggregate shared by the customer list, its visited= filters and
// the single-customer card.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let rep;
let director;
let cookie;
let visited;
let neverVisited;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  cookie = await loginAs(admin.email);
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  visited = await createCustomer({ created_by: admin.id });
  neverVisited = await createCustomer({ created_by: admin.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now(), 40.1, 44.5, 5, true), ($1, $2, now() - interval '30 days', 40.1, 44.5, 5, true)`,
    [visited.id, rep.id]
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

test("only a field rep's in-range check-in is a visit: a director's, or one made far away, is not", async () => {
  const c = await createCustomer({ created_by: admin.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now(), 40.1, 44.5, 5, true),                      -- director, in range: saved, not a visit
            ($1, $3, now() - interval '1 day', 40.1, 44.5, 900, false), -- rep, far from the pin
            ($1, $3, now() - interval '2 days', 40.1, 44.5, 800, false)`,
    [c.id, director.id, rep.id]
  );
  const card = await apiRequest(`/api/customers/${c.id}`, { cookie });
  assert.equal(card.data.last_visit_at, null);
  assert.equal(card.data.visited_today, false);
  assert.equal(card.data.far_visits, 2);

  const facts = await apiRequest(`/api/customers/${c.id}/map-facts`, { cookie });
  assert.equal(facts.data.last_visit_at, null);
  assert.equal(facts.data.far_visits, 2);
  const batch = await apiRequest(`/api/customers/map-facts?ids=${c.id}`, { cookie });
  assert.equal(batch.data[c.id].last_visit_at, null);
  assert.equal(batch.data[c.id].far_visits, 2);

  // The rep then really visits: it counts, and the director's visit still adds nothing of its own.
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now() - interval '3 days', 40.1, 44.5, 5, true)`,
    [c.id, rep.id]
  );
  const after = await apiRequest(`/api/customers/${c.id}`, { cookie });
  assert.equal(new Date(after.data.last_visit_at).getTime() < Date.now() - 2 * 24 * 3600 * 1000, true);
  assert.equal(after.data.visited_today, false);
});
