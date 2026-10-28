// Potential Customer classification: level 1-4 + reasons + history, the counterfeit restriction on genuine Castrol, access by role.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, rep2, director, accountant, cookies = {}, customer, castrol, other;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  for (const [k, u] of Object.entries({ rep, rep2, director, accountant })) cookies[k] = await loginAs(u.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  castrol = await createProduct({ unit: "4L" });
  other = await createProduct({ unit: "4L" });
  await pool.query("UPDATE products SET brand = 'Castrol' WHERE id = $1", [castrol.id]);
  await pool.query("UPDATE products SET brand = 'Lotos' WHERE id = $1", [other.id]);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const put = (who, id, body) => apiRequest(`/api/customers/${id}/potential`, { method: "PUT", cookie: cookies[who], body });
const row = async (id) => (await pool.query("SELECT potential_level, potential_reasons, potential_reason_other, counterfeit_flag, counterfeit_resolved_by, counterfeit_resolved_comment, next_followup_date::text AS next_followup_date, expected_volume_l::float8 AS expected_volume_l FROM customers WHERE id = $1", [id])).rows[0];

test("a sales manager sets the level + reasons of their own customer; validation; history keeps every change", async () => {
  assert.equal((await put("rep", customer.id, { level: 9, reasons: ["high_potential"] })).status, 400);
  assert.equal((await put("rep", customer.id, { level: 5, reasons: ["high_potential"] })).status, 400, "there is no Very high level any more");
  assert.equal((await put("rep", customer.id, { level: 4, reasons: [] })).status, 400, "a reason is required");
  assert.equal((await put("rep", customer.id, { level: 4, reasons: ["nope"] })).status, 400);
  assert.equal((await put("rep", customer.id, { level: 4, reasons: ["other"] })).status, 400, "Other needs an explanation");
  assert.equal((await put("rep2", customer.id, { level: 4, reasons: ["high_potential"] })).status, 403, "someone else's customer");
  assert.equal((await put("accountant", customer.id, { level: 4, reasons: ["high_potential"] })).status, 403);
  assert.equal((await put("rep", 999999999, { level: 4, reasons: ["high_potential"] })).status, 404);

  const first = await put("rep", customer.id, { level: 3, reasons: ["active_interest"], next_followup_date: "2026-11-03", expected_volume_l: 120 });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  let r = await row(customer.id);
  assert.deepEqual([r.potential_level, r.potential_reasons, r.next_followup_date, r.expected_volume_l], [3, ["active_interest"], "2026-11-03", 120]);

  const up = await put("rep", customer.id, { level: 4, reasons: ["negotiating", "other"], reason_other: "asked for the price list", note: "met the owner" });
  assert.equal(up.status, 200);
  const same = await put("rep", customer.id, { level: 4, reasons: ["other", "negotiating"], reason_other: "asked for the price list" });
  assert.equal(same.data.changed, false, "the same level and reasons again writes no history");
  assert.equal((await put("director", customer.id, { level: 2, reasons: ["not_interested"], note: "cooled down" })).status, 200, "management can change any customer");

  const hist = (await apiRequest(`/api/customers/${customer.id}/potential-history`, { cookie: cookies.director })).data;
  assert.deepEqual(hist.filter((h) => h.kind === "level").map((h) => [h.old_level, h.new_level]), [[4, 2], [3, 4], [null, 3]]);
  assert.equal(hist[1].note, "met the owner");
  assert.equal(hist[1].reason_other, "asked for the price list");
  assert.ok(hist[0].changed_by_name);
  assert.equal((await apiRequest(`/api/customers/${customer.id}/potential-history`, { cookie: cookies.rep2 })).status, 403);
  assert.equal((await apiRequest(`/api/customers/${customer.id}/potential-history`, { cookie: cookies.rep })).status, 200);
});

test("only potential customers have a level", async () => {
  const active = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = $1", [active.id]);
  assert.equal((await put("rep", active.id, { level: 3, reasons: ["high_potential"] })).status, 400);
});

test("counterfeit: the reason raises the flag, genuine Castrol is blocked, other brands are not, management resolves it with history", async () => {
  const c = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  assert.equal((await put("rep", c.id, { level: 1, reasons: ["counterfeit"] })).data.counterfeit_flag, true);
  assert.equal((await row(c.id)).counterfeit_flag, true);

  const order = (productId) => apiRequest("/api/orders", { method: "POST", cookie: cookies.rep, body: { customer_id: c.id, payment_method: "invoice", items: [{ product_id: productId, quantity: 1 }] } });
  const blocked = await order(castrol.id);
  assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
  assert.match(blocked.data.error, /counterfeit/i);
  const fine = await order(other.id);
  assert.equal(fine.status, 201, JSON.stringify(fine.data));
  trackOrder(fine.data.id);

  // the rep can keep working on the customer but cannot lift the restriction
  assert.equal((await put("rep", c.id, { level: 2, reasons: ["counterfeit", "small_volume"] })).status, 200);
  assert.equal((await apiRequest(`/api/customers/${c.id}/counterfeit-resolve`, { method: "POST", cookie: cookies.rep, body: {} })).status, 403);
  assert.equal((await apiRequest(`/api/customers/${c.id}/counterfeit-resolve`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 403);
  const done = await apiRequest(`/api/customers/${c.id}/counterfeit-resolve`, { method: "POST", cookie: cookies.director, body: { comment: "shop confirmed it stopped" } });
  assert.equal(done.status, 200);
  const r = await row(c.id);
  assert.equal(r.counterfeit_flag, false);
  assert.equal(r.counterfeit_resolved_by, director.id);
  assert.equal(r.counterfeit_resolved_comment, "shop confirmed it stopped");
  assert.equal((await apiRequest(`/api/customers/${c.id}/counterfeit-resolve`, { method: "POST", cookie: cookies.director, body: {} })).status, 409, "nothing left to resolve");
  const allowed = await order(castrol.id);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
  trackOrder(allowed.data.id);
  const hist = (await apiRequest(`/api/customers/${c.id}/potential-history`, { cookie: cookies.director })).data;
  assert.deepEqual(hist.map((h) => h.kind).filter((k) => k !== "level").sort(), ["counterfeit_resolved", "counterfeit_set"]);

  // a rep who keeps the reason ticked after the fix does not re-raise the flag; a NEW tick does
  await put("rep", c.id, { level: 2, reasons: ["counterfeit", "small_volume"] });
  assert.equal((await row(c.id)).counterfeit_flag, false);
  await put("rep", c.id, { level: 2, reasons: ["small_volume"] });
  await put("rep", c.id, { level: 1, reasons: ["counterfeit"] });
  assert.equal((await row(c.id)).counterfeit_flag, true);
});

test("creating a potential customer can carry its level", async () => {
  const res = await apiRequest("/api/customers", { method: "POST", cookie: cookies.rep, body: { name: `Potential ${Date.now()}`, lat: 40.2, lng: 44.5, potential_level: 4, potential_reasons: ["high_potential"] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.potential_level, 4);
  await pool.query("DELETE FROM customers WHERE id = $1", [res.data.id]);
  const bad = await apiRequest("/api/customers", { method: "POST", cookie: cookies.rep, body: { name: `Potential bad ${Date.now()}`, lat: 40.31, lng: 44.61, potential_level: 4, potential_reasons: [] } });
  assert.equal(bad.status, 400);
});

test("follow-up priority: higher level first among prospects, a due follow-up date is a reason of its own", async () => {
  const { visitPriorities } = await import("../../src/field/visitPriorities.js");
  const solo = await createUser("sales_manager");
  const mk = async (level, extra = {}) => {
    const c = await createCustomer({ created_by: solo.id, assigned_manager_id: solo.id, sales_channel: "SM YVN" });
    if (level) await pool.query("UPDATE customers SET potential_level = $2, potential_reasons = '{active_interest}' WHERE id = $1", [c.id, level]);
    if (extra.followup) await pool.query("UPDATE customers SET next_followup_date = $2 WHERE id = $1", [c.id, extra.followup]);
    return c;
  };
  const low = await mk(2);
  const very = await mk(4);
  const none = await mk(1);
  const unassessed = await mk(null);
  const picks = await visitPriorities(solo.id, 50); // all four were never visited: each has a reason to be on the card
  const order = picks.map((p) => p.customer_id);
  assert.ok(order.indexOf(very.id) < order.indexOf(unassessed.id), "high before not assessed");
  assert.ok(order.indexOf(unassessed.id) < order.indexOf(low.id), "not assessed before low");
  assert.ok(order.indexOf(low.id) < order.indexOf(none.id), "low before no potential");
  assert.ok(picks.find((p) => p.customer_id === very.id).reasons.some((r) => r.type === "potential" && r.level === 4));
  assert.ok(order.includes(none.id), "no potential stays on the list (never hidden)");
  // a due follow-up lifts a level-3 prospect above an unassessed one
  const dueC = await mk(3, { followup: "2020-01-01" });
  const picks2 = await visitPriorities(solo.id, 50);
  const due = picks2.find((p) => p.customer_id === dueC.id);
  assert.ok(due.reasons.some((r) => r.type === "followup_due"));
  assert.ok(picks2.map((p) => p.customer_id).indexOf(dueC.id) < picks2.map((p) => p.customer_id).indexOf(unassessed.id));
});

test("potential-summary: counts per level for management, only their own for a rep", async () => {
  const solo = await createUser("sales_manager");
  const soloCookie = await loginAs(solo.email);
  for (const lvl of [4, 4, 3, null]) {
    const c = await createCustomer({ created_by: solo.id, assigned_manager_id: solo.id });
    if (lvl) await pool.query("UPDATE customers SET potential_level = $2, next_followup_date = '2020-01-01' WHERE id = $1", [c.id, lvl]);
  }
  const mine = (await apiRequest("/api/customers/potential-summary", { cookie: soloCookie })).data;
  assert.deepEqual([mine.levels[4], mine.levels[3], mine.levels[0], mine.total, mine.followup_due], [2, 1, 1, 4, 3]);
  assert.deepEqual(mine.by_manager, [], "a rep gets no breakdown");
  const all = (await apiRequest("/api/customers/potential-summary", { cookie: cookies.director })).data;
  assert.ok(all.total >= 4 && all.levels[4] >= 2);
  const row = all.by_manager.find((m) => m.manager_id === solo.id);
  assert.deepEqual([row.levels[4], row.levels[3], row.total], [2, 1, 4]);
});

test("a prospect cannot be moved to Bronze / Silver / Gold without an ERP customer ID; with one it can", async () => {
  const c = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const admin = await createUser("admin");
  const adminCookie = await loginAs(admin.email);
  const patch = (body) => apiRequest(`/api/customers/${c.id}`, { method: "PATCH", cookie: adminCookie, body });
  const refused = await patch({ customer_tier: "gold" });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /ERP customer ID is required/);
  const ok = await patch({ customer_tier: "silver", erp_customer_id: `ITEST-TIER-${Date.now()}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // the edit sheet sends the current tier back with every save: an unchanged tier is never refused
  assert.equal((await patch({ customer_tier: "silver", notes: "again" })).status, 200);
});

test("the reasons a person last used per level are remembered on the server (never 'other' / 'counterfeit') and are private to that person", async () => {
  const mine = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  assert.equal((await apiRequest("/api/customers/potential-reason-memory")).status, 401);
  assert.deepEqual((await apiRequest("/api/customers/potential-reason-memory", { cookie: cookies.accountant })).data, {});
  assert.equal((await put("rep", mine.id, { level: 4, reasons: ["negotiating", "ready_first_order", "other"], reason_other: "typed" })).status, 200);
  assert.equal((await put("rep", mine.id, { level: 1, reasons: ["counterfeit", "price_mismatch"] })).status, 200);
  const memory = (await apiRequest("/api/customers/potential-reason-memory", { cookie: cookies.rep })).data;
  assert.deepEqual([...memory[4]].sort(), ["negotiating", "ready_first_order"]);
  assert.deepEqual(memory[1], ["price_mismatch"]);
  // the latest save for a level replaces the memory of that level
  assert.equal((await put("rep", mine.id, { level: 4, reasons: ["high_potential"] })).status, 200);
  assert.deepEqual((await apiRequest("/api/customers/potential-reason-memory", { cookie: cookies.rep })).data[4], ["high_potential"]);
  // another person sees none of it
  assert.deepEqual((await apiRequest("/api/customers/potential-reason-memory", { cookie: cookies.rep2 })).data, {});
});

test("the visit reasons 'gave_price_list' and 'introduced_products' are accepted", async () => {
  const mine = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const r = await put("rep", mine.id, { level: 3, reasons: ["gave_price_list", "introduced_products"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await put("rep", mine.id, { level: 3, reasons: ["made_up_reason"] })).status, 400);
});
