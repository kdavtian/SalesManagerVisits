// Migration 088: customers are visited every 7 days by default.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, trackCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("column defaults for visit frequency are 7 days (customers + app_settings)", async () => {
  const { rows } = await pool.query(
    `SELECT table_name, column_default FROM information_schema.columns
     WHERE (table_name = 'customers' AND column_name = 'visit_frequency_days')
        OR (table_name = 'app_settings' AND column_name = 'default_visit_frequency_days')`
  );
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.column_default, "7", r.table_name);
});

test("a customer created without an explicit frequency gets 7 days", async () => {
  const user = await createUser("sales_manager");
  const { rows } = await pool.query(
    "INSERT INTO customers (name, lat, lng, created_by) VALUES ('Itest default freq', 40.18, 44.51, $1) RETURNING id, visit_frequency_days",
    [user.id]
  );
  trackCustomer(rows[0].id);
  assert.equal(rows[0].visit_frequency_days, 7);
});
