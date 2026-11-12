// AI check of order-blank photos (aiBlankCheck.js): the verdict rules, the OFF-by-default switch, the cost cap and the stored result.
// The model is faked: the live call needs ANTHROPIC_API_KEY.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/shared/upload.js";
import { judgeBlank, judgeSlip, checkFileWithAi, checkRecentDocuments, setAiCheckEnabled, setAiCheckMonthlyCapUsd, getAiCheckSettings } from "../../src/customers/aiBlankCheck.js";
import { VAGHINAK_CHECKED_SQL } from "../../src/orders/vaghinakChecked.js";

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

const GOOD = { legible: true, order_number: "AIC-1", total_amd: 55500, customer_signature_present: true, rep_signature_present: true, payment_amd: null, notes: "" };
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
  // review 2026-11-12: a number or total that cannot be read proves nothing; "55 500" is read as 55500, garbage is "not read", never NaN
  assert.deepEqual(judgeBlank({ ...GOOD, order_number: null }, orders).issues.map((i) => i.code), ["order_number_not_read"]);
  assert.deepEqual(judgeBlank({ ...GOOD, total_amd: null }, orders).issues.map((i) => i.code), ["total_not_read"]);
  assert.equal(judgeBlank({ ...GOOD, total_amd: "55 500" }, orders).status, "ok");
  assert.deepEqual(judgeBlank({ ...GOOD, total_amd: "abc" }, orders).issues.map((i) => i.code), ["total_not_read"]);
});

async function addBlank(kind = "order_blank", { orderIds = [orderId], paymentId = null } = {}) {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
  const name = `aic-${Date.now()}-${fileIds.length}.jpg`;
  fs.writeFileSync(path.join(uploadDirPath, name), bytes);
  const { rows } = await pool.query(
    "INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, payment_id, created_by) VALUES ($1, $6, $2, 'image/jpeg', $3, $4, $7, $5) RETURNING id",
    [customer.id, name, bytes.length, orderIds, rep.id, kind, paymentId]
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
  // left as "error" (tried again later, a few times), never shown as a problem
  assert.equal((await pool.query("SELECT ai_status FROM customer_files WHERE id = $1", [id])).rows[0].ai_status, "error");

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

// Owner, 2026-11-12: Vaghinak reads the signed papers of delivered orders -- the payment written on them too -- and payment slips; a matching
// paper gives the order a "Checked" chip.
test("judgeBlank: the payment written on the paper must equal what was collected at delivery; judgeSlip: amount and both signatures", () => {
  assert.equal(judgeBlank({ ...GOOD, payment_amd: 20000 }, orders, { collectedAmd: 20000 }).status, "ok");
  assert.deepEqual(judgeBlank({ ...GOOD, payment_amd: 15000 }, orders, { collectedAmd: 20000 }).issues, [{ code: "payment_mismatch", found: 15000, expected: 20000 }]);
  assert.equal(judgeBlank(GOOD, orders, { collectedAmd: 20000 }).status, "ok", "an empty payment line is not an issue (not every rep fills it in)");
  assert.equal(judgeBlank(GOOD, orders, { collectedAmd: 0 }).status, "ok");
  // money on the paper the app never recorded (the cash a rep keeps)
  assert.deepEqual(judgeBlank({ ...GOOD, payment_amd: 50000 }, orders, { collectedAmd: 0 }).issues, [{ code: "payment_mismatch", found: 50000, expected: 0 }]);
  assert.deepEqual(judgeBlank({ ...GOOD, payment_amd: "50 000" }, orders, { collectedAmd: 50000 }).issues, []);
  // not delivered yet: the payment is not compared at all
  assert.equal(judgeBlank({ ...GOOD, payment_amd: 50000 }, orders, {}).status, "ok");
  const slip = { legible: true, amount_amd: 30000, receiver_signature_present: true, payer_signature_present: true, notes: "" };
  assert.equal(judgeSlip(slip, { amount_amd: 30000 }).status, "ok");
  assert.equal(judgeSlip(slip, { amount_amd: 31000 }).issues[0].code, "payment_mismatch");
  assert.deepEqual(judgeSlip({ ...slip, payer_signature_present: false }, null).issues, [{ code: "no_customer_signature" }]);
  assert.deepEqual(judgeSlip({ ...slip, receiver_signature_present: false }, null).issues, [{ code: "no_receiver_signature" }]);
  assert.equal(judgeSlip({ ...slip, amount_amd: "x" }, { amount_amd: 30000 }).issues[0].code, "payment_not_read");
  assert.equal(judgeSlip({ ...slip, legible: false }, null).status, "unreadable");
});

test("Checked chip: a delivered order whose blank matches is checked; a later correction of its total takes the chip away; a slip is read as a slip", async () => {
  await setAiCheckEnabled(true);
  const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'delivered', 40000, 'AIC-9') RETURNING id", [customer.id, rep.id]);
  const checked = async () => (await pool.query(`SELECT ${VAGHINAK_CHECKED_SQL} AS c FROM orders o WHERE o.id = $1`, [o.id])).rows[0].c;
  try {
    assert.equal(await checked(), false);
    const id = await addBlank("signed_act", { orderIds: [o.id] });
    // the round picks up unchecked papers of delivered orders
    const before = await checkRecentDocuments({ client: fakeModel({ ...GOOD, order_number: "AIC-9", total_amd: 40000 }), limit: 50, customerId: customer.id });
    assert.ok(before >= 1);
    assert.equal((await pool.query("SELECT ai_status FROM customer_files WHERE id = $1", [id])).rows[0].ai_status, "ok");
    assert.equal(await checked(), true);
    // the API carries it on the order
    const admin = await createUser("admin");
    const res = await apiRequest(`/api/orders/${o.id}`, { cookie: await loginAs(admin.email) });
    assert.equal(res.data.vaghinak_checked, true);
    // the same round again reads nothing more (the verdict is final): no second model call
    let calls = 0;
    const counting = { messages: { create: async () => { calls++; return { content: [{ type: "tool_use", input: GOOD }], usage: {} }; } } };
    await checkRecentDocuments({ client: counting, limit: 50, customerId: customer.id });
    assert.equal(calls, 0);
    // a return requested on the order takes the chip away
    const { rows: [ret] } = await pool.query(
      "INSERT INTO order_returns (order_id, customer_id, kind, reason, order_status_at_request, credit_amd, requested_by) VALUES ($1, $2, 'return', 'other', 'delivered', 0, $3) RETURNING id",
      [o.id, customer.id, rep.id]
    );
    {
      assert.equal(await checked(), false, "a return is under way: the paper no longer describes what the customer kept");
      await pool.query("DELETE FROM order_returns WHERE id = $1", [ret.id]);
      assert.equal(await checked(), true);
    }
    await pool.query("UPDATE orders SET total_amd = 45000 WHERE id = $1", [o.id]);
    assert.equal(await checked(), false, "corrected after the check: the old paper no longer proves it");

    // a payment slip goes through the slip reader (its tool) and is compared with its payment
    const { rows: [pay] } = await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
       VALUES ($1, 'x', 12000, now(), $2, 'x', 'approved', $2) RETURNING id`,
      [customer.id, rep.id]
    );
    {
      const slipId = await addBlank("payment_slip", { orderIds: [], paymentId: pay.id });
      let usedTool = null;
      const slipModel = { messages: { create: async (req) => { usedTool = req.tool_choice.name; return { content: [{ type: "tool_use", input: { legible: true, amount_amd: 12000, receiver_signature_present: true, payer_signature_present: true, notes: "" } }], usage: { input_tokens: 10, output_tokens: 10 } }; } } };
      assert.equal((await checkFileWithAi(slipId, { client: slipModel })).status, "ok");
      assert.equal(usedTool, "report_slip");
      await pool.query("DELETE FROM customer_files WHERE id = $1", [slipId]);
      await pool.query("DELETE FROM payments WHERE id = $1", [pay.id]);
    }
  } finally {
    await pool.query("DELETE FROM customer_files WHERE $1 = ANY(order_ids)", [o.id]);
    await pool.query("DELETE FROM orders WHERE id = $1", [o.id]);
  }
});

test("a paper read before delivery is read again after it (only then is the payment compared); a broken photo does not stop the round; two callers never pay twice", async () => {
  await setAiCheckEnabled(true);
  const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'confirmed', 30000, 'AIC-7') RETURNING id", [customer.id, rep.id]);
  const checked = async () => (await pool.query(`SELECT ${VAGHINAK_CHECKED_SQL} AS c FROM orders o WHERE o.id = $1`, [o.id])).rows[0].c;
  const read = { ...GOOD, order_number: "AIC-7", total_amd: 30000, payment_amd: 30000 };
  try {
    const id = await addBlank("order_blank", { orderIds: [o.id] });
    assert.equal((await checkFileWithAi(id, { client: fakeModel(read) })).status, "ok");
    await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [o.id]);
    assert.equal(await checked(), false, "read before delivery: proves no payment");
    // delivered, but the app recorded no money: the paper says 30 000 was paid -> the round re-reads it and finds the gap
    await checkRecentDocuments({ client: fakeModel(read), limit: 50, customerId: customer.id });
    const after = (await pool.query("SELECT ai_status, ai_result FROM customer_files WHERE id = $1", [id])).rows[0];
    assert.equal(after.ai_status, "issues");
    assert.deepEqual(after.ai_result.issues, [{ code: "payment_mismatch", found: 30000, expected: 0 }]);
    assert.equal(await checked(), false);

    // a photo the reader cannot open: "error", the round goes on with the next one
    const broken = await addBlank("order_blank", { orderIds: [o.id] });
    await pool.query("UPDATE customer_files SET file_path = 'missing-file.jpg' WHERE id = $1", [broken]);
    const good = await addBlank("order_blank", { orderIds: [o.id] });
    await checkRecentDocuments({ client: fakeModel(read), limit: 50, customerId: customer.id });
    const st = async (fid) => (await pool.query("SELECT ai_status, ai_attempts FROM customer_files WHERE id = $1", [fid])).rows[0];
    assert.deepEqual(await st(broken), { ai_status: "error", ai_attempts: 1 });
    assert.equal((await st(good)).ai_status, "issues", "the next paper was still read");

    // two callers at once: one model call
    const twin = await addBlank("order_blank", { orderIds: [o.id] });
    let calls = 0;
    const slow = { messages: { create: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return { content: [{ type: "tool_use", input: read }], usage: {} }; } } };
    await Promise.all([checkFileWithAi(twin, { client: slow }), checkFileWithAi(twin, { client: slow })]);
    assert.equal(calls, 1);
    // every call's cost is in the ledger
    const { rows: [l] } = await pool.query("SELECT count(*)::int AS n FROM ai_check_spend WHERE file_id = $1", [twin]);
    assert.equal(l.n, 1);
  } finally {
    await pool.query("DELETE FROM customer_files WHERE $1 = ANY(order_ids)", [o.id]);
    await pool.query("DELETE FROM orders WHERE id = $1", [o.id]);
  }
});
