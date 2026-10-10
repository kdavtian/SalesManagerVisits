// notifyUser() is called without await all over the routes; if the user is
// deleted before the insert lands it must not reject (unhandledRejection).
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { notifyUser } from "../../src/notifications.js";

test("notifyUser to a user that no longer exists resolves quietly", async () => {
  const { rows } = await pool.query("SELECT COALESCE(MAX(id), 0) + 1000000 AS id FROM users");
  await assert.doesNotReject(notifyUser(Number(rows[0].id), "task_assigned", { title: "x", body: "y" }));
  await pool.end();
});
