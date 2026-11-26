// The monthly market report job (checkMonthlyMarketReport): admin gets one summary on the 1st from 10:00 Yerevan, once per month.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { checkMonthlyMarketReport } from "../../src/reports/market/monthlyReport.js";

let admin;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("not before 10:00 on the 1st; then once, with the month in the title", async () => {
  assert.equal(await checkMonthlyMarketReport(new Date("2025-06-01T05:00:00Z")), 0, "09:00 Yerevan");
  assert.ok((await checkMonthlyMarketReport(new Date("2025-06-01T07:00:00Z"))) >= 1);
  const { rows } = await pool.query("SELECT title, body, url FROM notifications WHERE user_id = $1 AND type = 'market_monthly'", [admin.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /\(2025-05\)/);
  assert.match(rows[0].body, /^• /);
  assert.equal(rows[0].url, "/#/reports?r=market_shelf");
  assert.equal(await checkMonthlyMarketReport(new Date("2025-06-01T09:00:00Z")), 0, "once a month");
});
