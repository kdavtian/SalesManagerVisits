// GET /api/settings/admin-counts: the numbers beside the Administration categories (what is waiting for this user). Role-aware: a plain rep gets none,
// a plan waiting for approval raises "Sales & customers" for a director and an admin, and the counts are relative to what is already in the database.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let director;
let rep;
let cookies = {};
const planIds = [];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  cookies = { admin: await loginAs(admin.email), director: await loginAs(director.email), rep: await loginAs(rep.email) };
});
test.after(async () => {
  if (planIds.length) await pool.query("DELETE FROM visit_plans WHERE id = ANY($1)", [planIds]);
  await cleanupAll();
  await stopTestServer();
});

test("a plain rep gets no counts; admin and director get their own keys", async () => {
  assert.equal((await apiRequest("/api/settings/admin-counts")).status, 401);
  assert.deepEqual((await apiRequest("/api/settings/admin-counts", { cookie: cookies.rep })).data, {});
  const adminCounts = (await apiRequest("/api/settings/admin-counts", { cookie: cookies.admin })).data;
  assert.ok("a-sales" in adminCounts && "a-system" in adminCounts, JSON.stringify(adminCounts));
  const directorCounts = (await apiRequest("/api/settings/admin-counts", { cookie: cookies.director })).data;
  assert.ok("a-sales" in directorCounts);
  assert.ok(!("a-system" in directorCounts), "the Excel sync is the admin's");
});

test("a plan waiting for approval adds one to Sales & customers", async () => {
  const before = (await apiRequest("/api/settings/admin-counts", { cookie: cookies.director })).data["a-sales"];
  const { rows } = await pool.query(
    "INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, current_date + 400, '{}', 'pending', $1) RETURNING id",
    [rep.id]
  );
  planIds.push(rows[0].id);
  const after = (await apiRequest("/api/settings/admin-counts", { cookie: cookies.director })).data["a-sales"];
  assert.equal(after, before + 1);
});
