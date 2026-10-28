// AI check of order-blank photos (aiBlankCheck.js): the verdict rules, the OFF-by-default switch, the cost cap and the stored result.
// The model is faked: the live call needs ANTHROPIC_API_KEY.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/shared/upload.js";
import { judgeBlank, checkFileWithAi, setAiCheckEnabled, setAiCheckMonthlyCapUsd, getAiCheckSettings } from "../../src/customers/aiBlankCheck.js";

let rep;
let customer;
let orderId;
const fileIds = [];

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const { rows } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'delivered', 55500, 'AIC-1') RETURNING id", [customer.id, rep.id]);
  orderId = rows[0].id;
});
test.after(async () => {
  await setAiCheckEnabled(false);
  await setAiCheckMonthlyCapUsd(10);
  const { rows } = await pool.query("SELECT file_path FROM customer_files WHERE id = ANY($1)", [fileIds]);
  for (const r of rows) fs.rmSync(path.join(uploadDirPath, r.file_path), { force: true });
  await pool.query("DELETE FROM customer_files WHERE id = ANY($1)", [fileIds]);
  await pool.query("DELETE FROM orders WHERE id = $1", [orderId]);
  await cleanupAll();
  await stopTestServer();
});

const GOOD = { legible: true, order_number: "AIC-1", total_amd: 55500, customer_signature_present: true, rep_signature_present: true, notes: "" };
const orders = [{ order_code: "AIC-1", total_amd: 55500 }];

test("judgeBlank: ok, wrong number, wrong total, missing signatures, unreadable", () => {
  assert.deepEqual(judgeBlank(GOOD, orders), { status: "ok", issues: [] });
  const wrongNumber = judgeBlank({ ...GOOD, order_number: "999" }, orders);
  assert.equal(wrongNumber.status, "issues");
  assert.deepEqual(wrongNumber.issues[0], { code: "order_number_mismatch", found: "999", expected: "AIC-1" });
  assert.equal(judgeBlank({ ...GOOD, total_amd: 60000 }, orders).issues[0].code, "total_mismatch");
  assert.equal(judgeBlank({ ...GOOD, total_amd: 55501 }, orders).status, "ok", "1 AMD of rounding is fine");
  assert.deepEqual(judgeBlank({ ...GOOD, customer_signature_present: false, rep_signature_present: false }, orders).issues.map((i) => i.code), ["no_customer_signature", "no_rep_signature"]);
  assert.deepEqual(judgeBlank({ ...GOOD, legible: false }, orders), { status: "unreadable", issues: [{ code: "not_readable" }] });
  // two orders linked: the total is not compared (the paper may carry either)
  assert.equal(judgeBlank({ ...GOOD, total_amd: 1 }, [...orders, { order_code: "AIC-2", total_amd: 9 }]).status, "ok");
});

async function addBlank() {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
  const name = `aic-${Date.now()}-${fileIds.length}.jpg`;
  fs.writeFileSync(path.join(uploadDirPath, name), bytes);
  const { rows } = await pool.query(
    "INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, created_by) VALUES ($1, 'order_blank', $2, 'image/jpeg', $3, $4, $5) RETURNING id",
    [customer.id, name, bytes.length, [orderId], rep.id]
  );
  fileIds.push(rows[0].id);
  return rows[0].id;
}
const fakeModel = (input, usage = { input_tokens: 1500, output_tokens: 120 }) => ({
  messages: { create: async () => ({ content: [{ type: "tool_use", name: "report_blank", input }], usage }) },
});

test("the switch is OFF by default: nothing is checked until the admin turns it on", async () => {
  assert.equal((await getAiCheckSettings()).enabled, false);
  const id = await addBlank();
  assert.equal(await checkFileWithAi(id, { client: fakeModel(GOOD) }), null);
  assert.equal((await pool.query("SELECT ai_status FROM customer_files WHERE id = $1", [id])).rows[0].ai_status, null);
});

test("switched on: the verdict and its cost are stored; a problem is stored with its issues; a file is checked once", async () => {
  await setAiCheckEnabled(true);
  const okId = await addBlank();
  const ok = await checkFileWithAi(okId, { client: fakeModel(GOOD) });
  assert.equal(ok.status, "ok");
  const row = (await pool.query("SELECT ai_status, ai_result, ai_checked_at FROM customer_files WHERE id = $1", [okId])).rows[0];
  assert.equal(row.ai_status, "ok");
  assert.ok(row.ai_checked_at);
  assert.ok(row.ai_result.cost_usd > 0);
  assert.equal(await checkFileWithAi(okId, { client: fakeModel(GOOD) }), null, "already checked");

  const badId = await addBlank();
  const bad = await checkFileWithAi(badId, { client: fakeModel({ ...GOOD, customer_signature_present: false }) });
  assert.equal(bad.status, "issues");
  const stored = (await pool.query("SELECT ai_status, ai_result FROM customer_files WHERE id = $1", [badId])).rows[0];
  assert.equal(stored.ai_status, "issues");
  assert.deepEqual(stored.ai_result.issues, [{ code: "no_customer_signature" }]);

  // the inbox "Problems" filter lists it (admin sees everything)
  const admin = await createUser("admin");
  const list = await apiRequest("/api/files?period=&issues=1", { cookie: await loginAs(admin.email) });
  assert.ok(list.data.rows.some((f) => f.id === badId));
  assert.ok(!list.data.rows.some((f) => f.id === okId));
});

test("a failing model never blocks: the file stays unchecked; the monthly cap stops new checks", async () => {
  await setAiCheckEnabled(true);
  const id = await addBlank();
  const broken = { messages: { create: async () => { throw new Error("overloaded"); } } };
  assert.equal(await checkFileWithAi(id, { client: broken }), null);
  assert.equal((await pool.query("SELECT ai_status FROM customer_files WHERE id = $1", [id])).rows[0].ai_status, null);

  await setAiCheckMonthlyCapUsd(0.0001);
  assert.equal(await checkFileWithAi(id, { client: fakeModel(GOOD) }), null, "cap reached");
  await setAiCheckMonthlyCapUsd(10);
  assert.equal((await checkFileWithAi(id, { client: fakeModel(GOOD) })).status, "ok");
});

test("only the admin can switch the AI check or set its cap; everyone reads the switch", async () => {
  const admin = await createUser("admin");
  const adminCookie = await loginAs(admin.email);
  const repCookie = await loginAs(rep.email);
  assert.equal((await apiRequest("/api/settings", { cookie: repCookie })).data.ai_blank_check_enabled, true, "left on by the earlier test");
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: repCookie, body: { ai_blank_check_enabled: false } })).status, 403);
  const off = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ai_blank_check_enabled: false } });
  assert.equal(off.data.ai_blank_check_enabled, false);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ai_blank_check_enabled: "yes" } })).status, 400);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ai_blank_check_monthly_cap_usd: 0 } })).status, 400);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { ai_blank_check_monthly_cap_usd: 25 } })).data.ai_blank_check_monthly_cap_usd, 25);
  assert.equal(typeof (await apiRequest("/api/settings", { cookie: adminCookie })).data.ai_blank_check_configured, "boolean");
  // while it is off, the re-check button's endpoint refuses
  const id = await addBlank();
  const recheck = await apiRequest(`/api/files/${id}/ai-check`, { method: "POST", cookie: adminCookie });
  assert.equal(recheck.status, 409);
  assert.equal(recheck.data.code, "ai_check_off");
});
