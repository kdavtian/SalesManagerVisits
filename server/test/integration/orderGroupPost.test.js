// A confirmed order's details go to the accounting Telegram group (owner, 2026-11-23). orders/orderGroupPost.js compares what the order
// is now with what the group was last told: details on confirmation, again when anything of the document changes, "do not issue" when it
// is moved back / gets a stock issue / is cancelled / is deleted; a message the bot has not taken yet is corrected or withdrawn in place.
// ISOLATED (test/isolated-tests.txt): it flips app_settings.order_confirm_telegram, empties group_posts and runs the whole-database job.
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const SYNC = { "x-e2e-rate-limit-bypass": "itest-bypass", "X-Sync-Key": "itest-sync-key" };
const BOT = { "X-Sync-Key": "itest-sync-key" }; // exactly what the bot sends, no test bypass: for the check of its real budget

import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { orderConfirmedText, orderWithdrawnText, runOrderGroupPosts, syncOrderPost } from "../../src/orders/orderGroupPost.js";

let director, rep, admin, warehouse, directorCookie, repCookie, adminCookie, warehouseCookie, customer, oil, filter;
test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director", { name: "Post Director" });
  rep = await createUser("sales_manager", { name: "Post Rep" });
  admin = await createUser("admin", { name: "Post Admin" });
  warehouse = await createUser("warehouse_manager");
  [directorCookie, repCookie, adminCookie, warehouseCookie] = await Promise.all([director, rep, admin, warehouse].map((u) => loginAs(u.email)));
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `post-${Date.now()}`, name: "Post Shop" });
  await pool.query("UPDATE customers SET tin = '01234567', legal_name = 'Post Shop LLC', legal_address = 'Yerevan, Legal st. 1', address = 'Yerevan, Shop st. 2' WHERE id = $1", [customer.id]);
  oil = await createProduct({ name: "Castrol EDGE 5W-30", unit: "4L", unit_price_amd: 20000 });
  filter = await createProduct({ name: "Oil filter W712", unit: "pcs", unit_price_amd: 3000 });
  // the feature counts from when it was switched on: in this file, from before the first order
  await pool.query("UPDATE app_settings SET order_confirm_telegram = true, order_confirm_telegram_since = now() - interval '1 minute' WHERE id = 1");
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET order_confirm_telegram = true WHERE id = 1");
  await pool.query("DELETE FROM group_posts");
  await cleanupAll();
  await stopTestServer();
});

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
};
const postsOf = async (orderId) => (await pool.query("SELECT id, kind, text, posted_at, claimed_at FROM group_posts WHERE ref_id = $1 ORDER BY id", [orderId])).rows;
const kindsOf = async (orderId) => (await postsOf(orderId)).map((p) => p.kind);
// the route hooks run right after the answer: wait until the order's posts are exactly these kinds
const expectKinds = async (orderId, kinds, why = "") => {
  const got = await waitFor(async () => (JSON.stringify(await kindsOf(orderId)) === JSON.stringify(kinds) ? kinds : null));
  assert.deepEqual(got ?? (await kindsOf(orderId)), kinds, why);
  return postsOf(orderId);
};
async function submittedOrder(payment_method = "cash") {
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: repCookie,
    body: { customer_id: customer.id, payment_method, note: "deliver before noon", items: [{ product_id: oil.id, quantity: 2 }, { product_id: filter.id, quantity: 3 }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data).slice(0, 300));
  return trackOrder(created.data.id);
}
const confirm = async (id, cookie = directorCookie) => assert.equal((await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie, body: { status: "confirmed" } })).status, 200);
const unconfirm = async (id, reason) => assert.equal((await apiRequest(`/api/orders/${id}/unconfirm`, { method: "POST", cookie: directorCookie, body: { reason } })).status, 200);
// the bot takes what waits and reports it posted
async function botPostsEverything() {
  const pending = await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC });
  assert.equal(pending.status, 200, JSON.stringify(pending.data));
  for (const p of pending.data.posts) assert.equal((await apiRequest(`/api/erp-sync/group-posts/${p.id}/posted`, { method: "POST", headers: SYNC, body: { ok: true } })).status, 200);
  return pending.data.posts;
}

test("the director confirms: the details wait for the bot with everything a waybill needs; the bot takes them, and its polling fits its budget", async () => {
  const id = await submittedOrder("cash");
  assert.deepEqual(await kindsOf(id), [], "a submitted order is nobody's document yet");
  await confirm(id);
  const [post] = await expectKinds(id, ["order_confirmed"]);
  for (const part of ["✅", "բեռնագիր", "Post Shop", `ID ${customer.erp_customer_id}`, "1. Castrol EDGE 5W-30 4L\n", "2 հատ × 20,000 դր = 40,000 դր", "2. Oil filter W712\n", "3 հատ × 3,000 դր = 9,000 դր", "Ընդամենը՝ 49,000 դր", "deliver before noon", "Պատվիրեց՝ Post Rep", "Հաստատեց՝ Post Director"]) {
    assert.ok(post.text.includes(part), `"${part}" in:\n${post.text}`);
  }
  assert.ok(!post.text.includes("ՀՎՀՀ"), "a waybill does not show the TIN");

  assert.equal((await apiRequest("/api/erp-sync/group-posts/pending", { headers: { "X-Sync-Key": "wrong" } })).status, 401);
  assert.equal((await apiRequest(`/api/erp-sync/group-posts/${post.id}/posted`, { method: "POST", body: {} })).status, 401);
  const taken = await botPostsEverything();
  assert.ok(taken.some((p) => p.id === post.id && p.text === post.text));
  assert.deepEqual((await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC })).data.posts, [], "posted: not offered again");
  assert.equal((await apiRequest("/api/erp-sync/group-posts/999999999/posted", { method: "POST", headers: SYNC, body: {} })).status, 404);
  assert.equal((await apiRequest("/api/erp-sync/group-posts/99999999999/posted", { method: "POST", headers: SYNC, body: {} })).status, 400);
  // the bot asks every 30 seconds next to its other polls: 30 more requests in a row are all answered (the old shared limit was 20 per 15 minutes)
  for (let i = 0; i < 30; i++) assert.equal((await apiRequest("/api/erp-sync/group-posts/pending", { headers: BOT })).status, 200, `poll ${i}`);
  // and the cash sheets and the money board it asks for in the same 30 seconds are on the same roomy budget, not the Excel push's
  for (const path of ["/cash-sheets/pending", "/money-board/pending"]) {
    for (let i = 0; i < 12; i++) assert.equal((await apiRequest(`/api/erp-sync${path}`, { headers: BOT })).status, 200, `${path} ${i}`);
  }
});

test("after the group saw it: moved back -> 'do not issue yet'; confirmed again -> the details marked as changed; cancelled later -> 'cancelled'", async () => {
  const id = await submittedOrder("cash");
  await confirm(id);
  await expectKinds(id, ["order_confirmed"]);
  await botPostsEverything();
  await unconfirm(id, "wrong quantity");
  let posts = await expectKinds(id, ["order_confirmed", "order_unconfirmed"]);
  assert.ok(posts[1].text.includes("⏸") && posts[1].text.includes("wrong quantity") && posts[1].text.includes("Post Director") && posts[1].text.includes("Post Shop"), posts[1].text);
  await confirm(id);
  posts = await expectKinds(id, ["order_confirmed", "order_unconfirmed", "order_confirmed"]);
  assert.ok(posts[2].text.startsWith("♻️"), posts[2].text);
  await botPostsEverything();
  // moved back again, and then the order is cancelled: the group is not left waiting for "a new message"
  await unconfirm(id, null);
  await expectKinds(id, ["order_confirmed", "order_unconfirmed", "order_confirmed", "order_unconfirmed"]);
  await pool.query("UPDATE orders SET status = 'draft', cancelled_at = now(), cancel_reason = 'customer closed', updated_at = now() WHERE id = $1", [id]);
  assert.deepEqual(await runOrderGroupPosts(), { cancelled: 1 }, "the job finds it without any route telling it");
  posts = await postsOf(id);
  assert.ok(posts.at(-1).kind === "order_cancelled" && posts.at(-1).text.includes("❌") && posts.at(-1).text.includes("customer closed"), posts.at(-1).text);
  assert.deepEqual(await runOrderGroupPosts(), {}, "said once");
});

test("before the bot took it: a quick move back withdraws the message, a quick change corrects it in place; nothing is said about what nobody saw", async () => {
  const id = await submittedOrder("cash");
  await confirm(id);
  await expectKinds(id, ["order_confirmed"]);
  await unconfirm(id, null);
  await expectKinds(id, [], "withdrawn, and no 'do not issue' about a message nobody read");
  await confirm(id);
  const [first] = await expectKinds(id, ["order_confirmed"]);
  assert.ok(first.text.startsWith("✅"), "the group never saw the first one, so this is not 'changed'");
  // corrected while it still waits: the same message, new content
  const corrected = await apiRequest(`/api/orders/${id}/correct`, { method: "POST", cookie: adminCookie, body: { reason: "customer asked", items: [{ product_id: oil.id, quantity: 5 }] } });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data).slice(0, 300));
  const [same] = await waitFor(async () => ((await postsOf(id))[0]?.text.includes("5 հատ") ? postsOf(id) : null));
  assert.equal(same.id, first.id);
  assert.ok(same.text.includes("5 հատ × 20,000 դր = 100,000 դր") && !same.text.includes("Oil filter"), same.text);
  assert.deepEqual(await kindsOf(id), ["order_confirmed"]);
});

test("after the bot took it, every change of the document is said again: a correction, another payment method, a test order", async () => {
  const id = await submittedOrder("cash");
  await confirm(id);
  await expectKinds(id, ["order_confirmed"]);
  await botPostsEverything();
  const corrected = await apiRequest(`/api/orders/${id}/correct`, { method: "POST", cookie: adminCookie, body: { reason: "customer asked", items: [{ product_id: oil.id, quantity: 1 }] } });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data).slice(0, 300));
  let posts = await expectKinds(id, ["order_confirmed", "order_confirmed"]);
  assert.ok(posts[1].text.startsWith("♻️") && posts[1].text.includes("1 հատ × 20,000 դր"), posts[1].text);
  await botPostsEverything();
  // the document is asked for as an invoice instead of the waybill the group was told
  const asked = await apiRequest(`/api/orders/${id}/accounting-request`, { method: "POST", cookie: directorCookie, body: { payment_method: "invoice" } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data).slice(0, 300));
  posts = await expectKinds(id, ["order_confirmed", "order_confirmed", "order_confirmed"]);
  for (const part of ["♻️", "հաշիվ-ապրանքագիր", "Post Shop LLC", "ՀՎՀՀ՝ 01234567", "Yerevan, Legal st. 1"]) assert.ok(posts[2].text.includes(part), `"${part}" in:\n${posts[2].text}`);
  await botPostsEverything();
  // nothing changed: the job says nothing more
  assert.deepEqual(await runOrderGroupPosts(), {});
  // an admin's test of the accounting flow is marked as a test
  await pool.query("UPDATE orders SET accounting_is_test = true, updated_at = now() WHERE id = $1", [id]);
  assert.deepEqual(await runOrderGroupPosts(), { changed: 1 });
  assert.ok((await postsOf(id)).at(-1).text.includes("🧪"));
});

test("a stock issue and a deleted order take the details back; the bot's failed post is offered again and given up after 10 tries", async () => {
  const id = await submittedOrder("cash");
  await confirm(id);
  const [post] = await expectKinds(id, ["order_confirmed"]);
  // the bot takes it and fails: reported, offered again after the claim time, never more than 10 times
  const taken = await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC });
  assert.ok(taken.data.posts.some((p) => p.id === post.id));
  assert.deepEqual((await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC })).data.posts, [], "taken: a second bot does not get it at the same time");
  assert.equal((await apiRequest(`/api/erp-sync/group-posts/${post.id}/posted`, { method: "POST", headers: SYNC, body: { ok: false, error: "telegram down" } })).status, 200);
  await pool.query("UPDATE group_posts SET claimed_at = now() - interval '3 minutes' WHERE id = $1", [post.id]);
  assert.ok((await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC })).data.posts.some((p) => p.id === post.id), "offered again");
  await pool.query("UPDATE group_posts SET post_attempts = 10, claimed_at = now() - interval '3 minutes' WHERE id = $1", [post.id]);
  assert.deepEqual((await apiRequest("/api/erp-sync/group-posts/pending", { headers: SYNC })).data.posts, [], "given up");
  await pool.query("UPDATE group_posts SET posted_at = now() WHERE id = $1", [post.id]);

  // the warehouse flags a stock issue: the order is a draft again, the group is told not to issue it, with the note
  const issue = await apiRequest(`/api/warehouse/orders/${id}/stock-issue`, { method: "POST", cookie: warehouseCookie, body: { note: "no EDGE on the shelf" } });
  assert.equal(issue.status, 200, JSON.stringify(issue.data).slice(0, 200));
  const posts = await expectKinds(id, ["order_confirmed", "order_unconfirmed"]);
  assert.ok(posts[1].text.includes("no EDGE on the shelf"), posts[1].text);

  // an order deleted by the admin after the group saw it: "cancelled", with its code and customer though the order is gone
  const id2 = await submittedOrder("cash");
  await confirm(id2);
  await expectKinds(id2, ["order_confirmed"]);
  await botPostsEverything();
  const gone = await apiRequest(`/api/orders/${id2}`, { method: "DELETE", cookie: adminCookie, body: { reason: "entered twice" } });
  assert.ok(gone.status < 300, JSON.stringify(gone.data).slice(0, 200));
  const after = await expectKinds(id2, ["order_confirmed", "order_cancelled"]);
  assert.ok(after[1].text.includes("❌") && after[1].text.includes("Post Shop") && after[1].text.includes("Post Admin"), after[1].text);
  // ... and one deleted before the bot took its message leaves nothing behind
  const id3 = await submittedOrder("cash");
  await confirm(id3);
  await expectKinds(id3, ["order_confirmed"]);
  await apiRequest(`/api/orders/${id3}`, { method: "DELETE", cookie: adminCookie, body: { reason: "entered twice" } });
  await expectKinds(id3, []);
});

test("the switch: only admin; OFF announces nothing new but still takes back what the group has; ON again starts from now", async () => {
  const known = await submittedOrder("cash");
  await confirm(known);
  await expectKinds(known, ["order_confirmed"]);
  await botPostsEverything();

  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: directorCookie, body: { order_confirm_telegram: false } })).status, 403);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { order_confirm_telegram: "no" } })).status, 400);
  const off = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { order_confirm_telegram: false } });
  assert.equal(off.data.order_confirm_telegram, false);
  assert.equal((await apiRequest("/api/settings", { cookie: adminCookie })).data.order_confirm_telegram, false);

  const quiet = await submittedOrder("cash");
  await confirm(quiet);
  assert.equal(await syncOrderPost(quiet), null, "decided and written nothing");
  assert.deepEqual(await kindsOf(quiet), []);
  await unconfirm(known, "stop");
  await expectKinds(known, ["order_confirmed", "order_unconfirmed"], "the group has its details: still told not to issue it");

  const on = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { order_confirm_telegram: true } });
  assert.equal(on.data.order_confirm_telegram, true);
  assert.deepEqual(await runOrderGroupPosts(), {}, "the order confirmed while it was off is not announced afterwards");
  assert.deepEqual(await kindsOf(quiet), []);
  const fresh = await submittedOrder("cash");
  await confirm(fresh);
  await expectKinds(fresh, ["order_confirmed"]);
});

test("the job alone announces a confirmed order no route told about, once", async () => {
  const id = await submittedOrder("invoice");
  await pool.query("UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = $1", [id]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, 'submitted', 'confirmed', 'Confirmed', $2)", [id, director.id]);
  assert.deepEqual(await runOrderGroupPosts(), { announced: 1 });
  assert.deepEqual(await runOrderGroupPosts(), {});
  const [post] = await postsOf(id);
  for (const part of ["հաշիվ-ապրանքագիր", "ՀՎՀՀ՝ 01234567", "Հաստատեց՝ Post Director"]) assert.ok(post.text.includes(part), `"${part}" in:\n${post.text}`);
  // two calls at the same moment write one message
  const id2 = await submittedOrder("cash");
  await pool.query("UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = $1", [id2]);
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, 'submitted', 'confirmed', 'Confirmed', $2)", [id2, director.id]);
  await Promise.all([syncOrderPost(id2), syncOrderPost(id2), syncOrderPost(id2)]);
  assert.deepEqual(await kindsOf(id2), ["order_confirmed"]);
});

test("the texts: discount, term, prepayment and missing data are said plainly", () => {
  const o = {
    id: 5, order_code: "KM-0005", customer: "Shop", erp_customer_id: null, tin: null, legal_name: null, legal_address: null, address: null, rep: "Rep", confirmed_by: "Boss",
    payment_method: "invoice", total_amd: 45000, discount_pct: 10, discount_amd: 0, payment_term_days: 14, downpayment_amd: 10000, promised: "25.11.2026", note: null, is_test: false,
    items: [{ product_name: "Castrol GTX 4L", size: "4L", quantity: 2.5, unit_price_amd: 20000, line_total_amd: 50000 }, { product_name: "Filter", size: "pcs", quantity: 1, unit_price_amd: 0, line_total_amd: 0 }],
  };
  const text = orderConfirmedText(o);
  for (const part of ["KM-0005", "⚠️ ERP ID չկա", "ՀՎՀՀ՝ ⚠️ չկա", "1. Castrol GTX 4L\n", "2.5 հատ", "2. Filter\n", "Գումար՝ 50,000 դր", "Զեղչ՝ 5,000 դր (10%)", "Ընդամենը՝ 45,000 դր", "Վճարման ժամկետ՝ 14 օր", "Կանխավճար՝ 10,000 դր", "Առաքում՝ 25.11.2026", "Հաստատեց՝ Boss"]) {
    assert.ok(text.includes(part), `"${part}" in:\n${text}`);
  }
  const cancelled = orderWithdrawnText({ title: "KM-0005 · Shop", by: "Boss", reason: "customer refused", cancelled: true });
  assert.ok(cancelled.includes("❌") && cancelled.includes("customer refused") && cancelled.includes("Որոշեց՝ Boss"), cancelled);
});
