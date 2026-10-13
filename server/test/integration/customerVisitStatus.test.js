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

test("only a field rep's check-in is a visit (a director's is not); distance does not matter", async () => {
  const c = await createCustomer({ created_by: admin.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now(), 40.1, 44.5, 5, true)`, // director, in range: saved, not a visit
    [c.id, director.id]
  );
  const card = await apiRequest(`/api/customers/${c.id}`, { cookie });
  assert.equal(card.data.last_visit_at, null);
  assert.equal(card.data.visited_today, false);

  // A rep's check-in made far from the pin (old data, or a pin that was wrong) still counts as the visit.
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range)
     VALUES ($1, $2, now() - interval '2 days', 40.1, 44.5, 900, false)`,
    [c.id, rep.id]
  );
  const after = await apiRequest(`/api/customers/${c.id}`, { cookie });
  assert.ok(after.data.last_visit_at, "a far check-in by a rep is the last visit");
  assert.equal(after.data.visited_today, false, "the director's check-in today does not make it visited today");
  const facts = await apiRequest(`/api/customers/${c.id}/map-facts`, { cookie });
  assert.equal(new Date(facts.data.last_visit_at).getTime(), new Date(after.data.last_visit_at).getTime());
  const batch = await apiRequest(`/api/customers/map-facts?ids=${c.id}`, { cookie });
  assert.equal(new Date(batch.data[c.id].last_visit_at).getTime(), new Date(after.data.last_visit_at).getTime());
});
