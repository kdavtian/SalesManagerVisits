// KAD OS <-> KAD Motors: a linked account's orders are app orders (flat discount, campaigns, delivery promise, queue priority), it sees only its
// own customer through /api/partner/*, and the supplier runs campaigns / settings / account links.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { orderFlow } from "../../src/opsReports.js";

const stamp = Date.now();
let admin, director, rep, partner, other, adminCookie, directorCookie, repCookie, partnerCookie;
let shop, rival, p1, p2;
const campaignIds = [];
let savedSettings;

async function setPrice(p, price, net) {
  await pool.query("UPDATE products SET bronze_price_amd = $2, silver_price_amd = $2, unit_price_amd = $2, net_cost_amd = $3, stock_qty = 100 WHERE id = $1", [p.id, price, net]);
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  partner = await createUser("sales_manager", { name: "KAD OS - Test Shop" });
  other = await createUser("sales_manager", { name: "KAD OS - Rival" });
  [adminCookie, directorCookie, repCookie, partnerCookie] = await Promise.all([admin, director, rep, partner].map((u) => loginAs(u.email)));
  shop = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `KOS-SHOP-${stamp}`, name: `KOS Shop ${stamp}` });
  rival = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `KOS-RIVAL-${stamp}`, name: `KOS Rival ${stamp}` });
  await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = ANY($1)", [[shop.id, rival.id]]);
  p1 = await createProduct({ unit: "4L", name: `KOS Oil A ${stamp}` });
  p2 = await createProduct({ unit: "1L", name: `KOS Oil B ${stamp}` });
  await setPrice(p1, 10000, 6000);
  await setPrice(p2, 5000, 3000);
  await pool.query("INSERT INTO partner_links (user_id, customer_id) VALUES ($1, $2), ($3, $4)", [partner.id, shop.id, other.id, rival.id]);
  savedSettings = (await pool.query("SELECT app_orders FROM app_settings WHERE id = 1")).rows[0]?.app_orders ?? {};
  await pool.query("INSERT INTO app_settings (id, app_orders) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET app_orders = '{}'::jsonb");
});
test.after(async () => {
  await pool.query("DELETE FROM campaigns WHERE id = ANY($1)", [campaignIds]);
  await pool.query("DELETE FROM route_stops WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1))", [[shop.id, rival.id]]);
  await pool.query("DELETE FROM delivery_routes WHERE created_by = $1", [admin.id]);
  await pool.query("DELETE FROM orders WHERE customer_id = ANY($1)", [[shop.id, rival.id]]);
  await pool.query("DELETE FROM partner_links WHERE user_id = ANY($1)", [[partner.id, other.id]]);
  await pool.query("INSERT INTO app_settings (id, app_orders) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET app_orders = EXCLUDED.app_orders", [JSON.stringify(savedSettings)]);
  await cleanupAll();
  await stopTestServer();
});

const order = (cookie, items, extra = {}) => apiRequest("/api/partner/orders", { method: "POST", cookie, body: { items, payment_method: "invoice", payment_term_days: 45, ...extra } });
const q = (product, quantity) => ({ product_id: product.id, quantity });
const mkCampaign = (body, cookie = adminCookie) =>
  apiRequest("/api/app-orders/campaigns", { method: "POST", cookie, body: { title: `KOS camp ${stamp}`, kind: "discount", percent: 10, starts_on: "2020-01-01", ends_on: "2099-12-31", audience: "all", products: [{ product_id: p1.id, min_qty: 1 }], ...body } });

test("an account that is not linked has no partner access", async () => {
  const r = await apiRequest("/api/partner/me", { cookie: repCookie });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "not_partner");
  assert.equal((await apiRequest("/api/partner/me")).status, 401);
});

test("app order: flat 2 % discount, forced customer, request discount ignored, delivery promise, APP marker", async () => {
  const r = await order(partnerCookie, [q(p1, 2)], { customer_id: rival.id, discount_pct: 50, discount_amd: 99999 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackOrder(r.data.id);
  assert.equal(r.data.customer_id, shop.id, "the linked customer, whatever the request says");
  assert.equal(r.data.placed_via_app, true);
  assert.equal(Number(r.data.discount_amd), 400, "2 % of 20,000");
  assert.equal(Number(r.data.discount_pct), 0);
  assert.equal(Number(r.data.total_amd), 19600);
  assert.equal(Number(r.data.app_discount_pct), 2);
  assert.equal(r.data.approval_status, "approved", "2 % is inside the 3 % auto-approval");
  assert.equal(r.data.status, "submitted");
  assert.match(String(r.data.promised_date), /^\d{4}-\d{2}-\d{2}/);
  // The same order through the ordinary endpoint is an app order too (an account cannot dodge the rules).
  const viaOrders = await apiRequest("/api/orders", { method: "POST", cookie: partnerCookie, body: { customer_id: rival.id, items: [q(p1, 1)], payment_method: "cash", discount_pct: 40 } });
  trackOrder(viaOrders.data.id);
  assert.equal(viaOrders.data.customer_id, shop.id);
  assert.equal(viaOrders.data.placed_via_app, true);
  assert.equal(Number(viaOrders.data.total_amd), 9800);
  // An ordinary sales manager's order is unchanged.
  const normal = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(normal.data.id);
  assert.equal(normal.data.placed_via_app, false);
  assert.equal(Number(normal.data.total_amd), 10000);
  assert.equal(normal.data.promised_date, null);
});

test("a KAD OS account can use only the partner API (and place orders), nothing else in KAD", async () => {
  for (const path of ["/api/products", "/api/customers", "/api/orders", "/api/debt-balances", "/api/users", "/api/payments"]) {
    const r = await apiRequest(path, { cookie: partnerCookie });
    assert.equal(r.status, 403, path);
    assert.equal(r.data.code, "partner_only", path);
  }
  assert.equal((await apiRequest("/api/partner/me", { cookie: partnerCookie })).status, 200);
  // an ordinary sales manager is unaffected
  assert.equal((await apiRequest("/api/products", { cookie: repCookie })).status, 200);
});

test("preview prices a basket exactly like the order", async () => {
  const pv = await apiRequest("/api/partner/preview", { method: "POST", cookie: partnerCookie, body: { items: [q(p1, 2), q(p2, 4)] } });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.subtotal_amd, 40000);
  assert.equal(pv.data.app_discount_amd, 800);
  assert.equal(pv.data.total_amd, 39200);
  const real = await order(partnerCookie, [q(p1, 2), q(p2, 4)]);
  trackOrder(real.data.id);
  assert.equal(Number(real.data.total_amd), pv.data.total_amd);
  assert.equal((await apiRequest("/api/partner/preview", { method: "POST", cookie: partnerCookie, body: { items: [] } })).status, 400);
});

test("settings: admin changes the discount, others cannot; Off gives no discount", async () => {
  assert.equal((await apiRequest("/api/app-orders/settings", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/app-orders/settings", { cookie: directorCookie })).status, 403, "the sales director runs campaigns, not the perks");
  assert.equal((await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { discount_pct: 50 } })).status, 400);
  const off = await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { discount_enabled: false } });
  assert.equal(off.status, 200);
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  assert.equal(Number(r.data.total_amd), 10000);
  assert.equal(r.data.app_discount_pct, null);
  const three = await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { discount_enabled: true, discount_pct: 3 } });
  assert.equal(three.data.settings.discount_pct, 3);
  const r3 = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r3.data.id);
  assert.equal(Number(r3.data.total_amd), 9700);
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { discount_pct: 2 } });
});

test("campaign: line price replaces the app discount (no stacking); the sales director can create it; ordinary orders do not get it", async () => {
  assert.equal((await mkCampaign({}, repCookie)).status, 403);
  const c = await mkCampaign({}, directorCookie);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  campaignIds.push(c.data.id);
  assert.equal(c.data.state, "running");
  const r = await order(partnerCookie, [q(p1, 2), q(p2, 2)]);
  trackOrder(r.data.id);
  const items = (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data.items;
  const a = items.find((i) => i.product_id === p1.id);
  const b = items.find((i) => i.product_id === p2.id);
  assert.equal(a.unit_price, 9000);
  assert.equal(a.list_price, 10000);
  assert.equal(a.campaign_id, c.data.id);
  assert.equal(b.unit_price, 5000);
  assert.equal(Number(r.data.discount_amd), 200, "2 % of the uncovered line only (10,000)");
  assert.equal(Number(r.data.total_amd), 18000 + 10000 - 200);
  const normal = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(normal.data.id);
  assert.equal(Number(normal.data.total_amd), 10000, "campaigns are app-only");
  const offers = await apiRequest("/api/partner/offers", { cookie: partnerCookie });
  assert.ok(offers.data.offers.some((o) => o.id === c.data.id));
  await apiRequest(`/api/app-orders/campaigns/${c.data.id}`, { method: "PATCH", cookie: adminCookie, body: { paused: true } });
  const after = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(after.data.id);
  assert.equal(Number(after.data.total_amd), 9800, "a paused campaign no longer applies");
  const used = await apiRequest(`/api/app-orders/campaigns/${c.data.id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(used.status, 409, "a campaign already on orders is ended, not deleted");
  const end = await apiRequest(`/api/app-orders/campaigns/${c.data.id}`, { method: "PATCH", cookie: adminCookie, body: { paused: false, end_now: true } });
  assert.equal(end.data.state, "ended");
});

test("selected audience reaches only the chosen customers; a bundle needs every product", async () => {
  const mine = await mkCampaign({ audience: "selected", customer_ids: [shop.id], kind: "bundle", percent: 5, products: [{ product_id: p1.id, min_qty: 2 }, { product_id: p2.id, min_qty: 2 }] });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  campaignIds.push(mine.data.id);
  const half = await order(partnerCookie, [q(p1, 2)]);
  trackOrder(half.data.id);
  assert.equal(Number(half.data.total_amd), 19600, "only one of the bundle's products: just the app discount");
  const full = await order(partnerCookie, [q(p1, 2), q(p2, 2)]);
  trackOrder(full.data.id);
  assert.equal(Number(full.data.total_amd), 19000 + 9500, "5 % off both bundle lines, no app discount on top");
  const rivalOrder = await order((await loginAs(other.email)), [q(p1, 2), q(p2, 2)]);
  trackOrder(rivalOrder.data.id);
  assert.equal(Number(rivalOrder.data.total_amd), 30000 - 600, "the rival customer is not in the audience");
  const rivalOffers = await apiRequest("/api/partner/offers", { cookie: await loginAs(other.email) });
  assert.ok(!rivalOffers.data.offers.some((o) => o.id === mine.data.id));
  await apiRequest(`/api/app-orders/campaigns/${mine.data.id}`, { method: "PATCH", cookie: adminCookie, body: { end_now: true } });
});

test("campaign validation: below-cost price is refused, bundle needs two products, dates and audience are checked", async () => {
  const cheap = await mkCampaign({ percent: 45 }); // 10,000 -> 5,500, net cost 6,000
  assert.equal(cheap.status, 409);
  assert.equal(cheap.data.code, "below_cost");
  assert.equal((await mkCampaign({ kind: "bundle" })).status, 400);
  assert.equal((await mkCampaign({ starts_on: "2026-12-31", ends_on: "2026-01-01" })).status, 400);
  assert.equal((await mkCampaign({ audience: "selected", customer_ids: [] })).status, 400);
  assert.equal((await mkCampaign({ percent: 60 })).status, 400);
  assert.equal((await mkCampaign({ title: "" })).status, 400);
  assert.equal((await mkCampaign({ products: [] })).status, 400);
});

test("statuses: received, confirmed, packed, on the way, delivered -- with times, and only the own customer's orders", async () => {
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const get = async () => (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal((await get()).status, "received");
  const hist = (status) => pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, 'x', $2, $3)", [r.data.id, status, admin.id]);
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [r.data.id]);
  await hist("confirmed");
  const confirmed = await get();
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.timeline.find((t) => t.step === "confirmed").at);
  await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [r.data.id]);
  await hist("packed_stock_out");
  assert.equal((await get()).status, "packed");
  const route = await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, current_date, $1) RETURNING id", [admin.id]);
  await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, 1)", [route.rows[0].id, r.data.id]);
  const onWay = await get();
  assert.equal(onWay.status, "on_the_way");
  assert.deepEqual(onWay.timeline.map((t) => t.done), [true, true, true, true, false]);
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [r.data.id]);
  assert.equal((await get()).status, "delivered");
  // isolation
  const rivalCookie = await loginAs(other.email);
  assert.equal((await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: rivalCookie })).status, 404);
  const list = (await apiRequest("/api/partner/orders", { cookie: rivalCookie })).data.orders;
  assert.ok(!list.some((o) => o.id === r.data.id));
});

test("balance: debt, overdue part, credit limit and payments of the own customer", async () => {
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', 500000, 0, now()) ON CONFLICT (erp_customer_id) DO UPDATE SET debt_amd = 500000", [shop.erp_customer_id]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - 80, 500000)", [shop.erp_customer_id, `KOS-${stamp}`]);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date - 3, 123000)", [shop.erp_customer_id]);
  await pool.query("UPDATE customers SET credit_limit_amd = 2000000 WHERE id = $1", [shop.id]);
  try {
    const b = (await apiRequest("/api/partner/balance", { cookie: partnerCookie })).data;
    assert.equal(b.debt_amd, 500000);
    assert.equal(b.overdue_amd, 500000, "80 days old, 45-day terms");
    assert.ok(b.oldest_due_days > 0);
    assert.equal(b.credit_limit_amd, 2000000);
    assert.ok(b.available_credit_amd < 1500000 && b.available_credit_amd >= 0);
    assert.equal(b.payments[0].amount, 123000);
    const me = (await apiRequest("/api/partner/me", { cookie: partnerCookie })).data;
    assert.equal(me.customer.id, shop.id);
    assert.equal(me.balance.debt_amd, 500000);
  } finally {
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [shop.erp_customer_id]);
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [shop.erp_customer_id]);
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [shop.erp_customer_id]);
  }
});

test("progress: orders this month decide the level; savings and the app share are counted", async () => {
  const me = (await apiRequest("/api/partner/me", { cookie: partnerCookie })).data;
  assert.ok(me.progress.orders_this_month >= 5);
  assert.ok(me.progress.level >= 2, `level ${me.progress.level}`);
  assert.ok(me.progress.saved_this_month_amd > 0);
  assert.ok(me.progress.streak.weeks >= 1);
  assert.equal(me.progress.streak.active_this_week, true);
  assert.equal(me.perks.discount_pct, 2);
  assert.ok(me.promised_date);
  const off = await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { progress_enabled: false } });
  assert.equal(off.status, 200);
  assert.equal((await apiRequest("/api/partner/me", { cookie: partnerCookie })).data.progress, null);
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { progress_enabled: true } });
});

test("queue priority: app orders come first in the waiting lists", async () => {
  const normal = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(normal.data.id);
  const app = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(app.data.id);
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = ANY($1)", [[normal.data.id, app.data.id]]);
  // the app order is NEWER; with priority it still is first -- make the ordinary one newer to prove it
  await pool.query("UPDATE orders SET created_at = now() + interval '1 minute' WHERE id = $1", [normal.data.id]);
  const list = (await apiRequest("/api/orders?status=confirmed", { cookie: adminCookie })).data.rows;
  const ia = list.findIndex((o) => o.id === app.data.id);
  const inorm = list.findIndex((o) => o.id === normal.data.id);
  assert.ok(ia >= 0 && inorm >= 0 && ia < inorm, "app first");
  assert.equal(list[ia].placed_via_app, true);
  const staging = (await apiRequest("/api/warehouse/staging-list", { cookie: adminCookie })).data;
  const sa = staging.findIndex((o) => o.id === app.data.id);
  const sn = staging.findIndex((o) => o.id === normal.data.id);
  assert.ok(sa >= 0 && sn >= 0 && sa < sn, "warehouse staging: app first");
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { priority_enabled: false } });
  const flat = (await apiRequest("/api/orders?status=confirmed", { cookie: adminCookie })).data.rows;
  assert.ok(flat.findIndex((o) => o.id === normal.data.id) < flat.findIndex((o) => o.id === app.data.id), "priority Off: plain newest-first");
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { priority_enabled: true } });
});

test("staff editing an app order's items keeps the campaign price and the app discount", async () => {
  const c = await mkCampaign({ percent: 10 });
  campaignIds.push(c.data.id);
  const r = await order(partnerCookie, [q(p1, 1), q(p2, 2)]);
  trackOrder(r.data.id);
  assert.equal(Number(r.data.total_amd), 9000 + 10000 - 200);
  const edit = await apiRequest(`/api/orders/${r.data.id}`, { method: "PATCH", cookie: adminCookie, body: { items: [q(p1, 3), q(p2, 2)] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const after = (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal(after.items.find((i) => i.product_id === p1.id).unit_price, 9000);
  assert.equal(after.total_amd, 27000 + 10000 - 200);
  await apiRequest(`/api/app-orders/campaigns/${c.data.id}`, { method: "PATCH", cookie: adminCookie, body: { end_now: true } });
});

test("account links: admin links a customer-bound account; admin/CEO accounts and unlinked customers are refused", async () => {
  const fresh = await createUser("sales_manager");
  const noErp = await createCustomer({ created_by: admin.id, name: `KOS NoErp ${stamp}` });
  assert.equal((await apiRequest("/api/app-orders/links", { method: "POST", cookie: repCookie, body: { user_id: fresh.id, customer_id: shop.id } })).status, 403);
  assert.equal((await apiRequest("/api/app-orders/links", { method: "POST", cookie: adminCookie, body: { user_id: admin.id, customer_id: shop.id } })).status, 400);
  assert.equal((await apiRequest("/api/app-orders/links", { method: "POST", cookie: adminCookie, body: { user_id: fresh.id, customer_id: noErp.id } })).status, 400);
  const ok = await apiRequest("/api/app-orders/links", { method: "POST", cookie: adminCookie, body: { user_id: fresh.id, customer_id: shop.id } });
  assert.equal(ok.status, 201);
  assert.ok(ok.data.links.some((l) => l.user_id === fresh.id && l.customer_id === shop.id));
  const gone = await apiRequest(`/api/app-orders/links/${fresh.id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(gone.status, 200);
  assert.ok(!gone.data.links.some((l) => l.user_id === fresh.id));
  await pool.query("DELETE FROM partner_links WHERE user_id = $1", [fresh.id]);
});

test("catalog: tier prices and availability, no costs", async () => {
  const cat = (await apiRequest("/api/partner/catalog", { cookie: partnerCookie })).data;
  const a = cat.products.find((p) => p.id === p1.id);
  assert.equal(a.price, 10000);
  assert.equal("available" in a, false, "no stock figure leaves KAD Motors");
  assert.equal(a.max_qty, 16, "a 4 L pack: at most 16 pieces in one order");
  assert.equal(cat.products.some((p) => "net_cost_amd" in p || "landing_cost_amd" in p), false);
  assert.equal(cat.customer.id, shop.id);
});

test("the sales manager of the customer sees the app order (read only) and is told about it; other reps do not see it", async () => {
  const stranger = await createUser("sales_manager");
  const strangerCookie = await loginAs(stranger.email);
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const mine = (await apiRequest("/api/orders", { cookie: repCookie })).data.rows;
  const row = mine.find((o) => o.id === r.data.id);
  assert.ok(row, "the customer's own sales manager sees the app order in Orders");
  assert.equal(row.placed_via_app, true);
  assert.equal((await apiRequest(`/api/orders/${r.data.id}`, { cookie: repCookie })).status, 200);
  assert.equal((await apiRequest(`/api/orders?customer_id=${shop.id}`, { cookie: repCookie })).data.rows.some((o) => o.id === r.data.id), true);
  assert.equal((await apiRequest(`/api/orders/${r.data.id}`, { method: "PATCH", cookie: repCookie, body: { note: "x" } })).status, 403, "read only: only the owner or an admin edits");
  assert.equal((await apiRequest("/api/orders", { cookie: strangerCookie })).data.rows.some((o) => o.id === r.data.id), false);
  assert.equal((await apiRequest(`/api/orders/${r.data.id}`, { cookie: strangerCookie })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 300)); // the notification is written after the response
  const n = await pool.query("SELECT title FROM notifications WHERE user_id = $1 AND type = 'order_placed' ORDER BY id DESC LIMIT 1", [rep.id]);
  assert.match(n.rows[0]?.title ?? "", /KAD OS/);
  // ... and an ordinary order of the same customer is still only visible to whoever made it
  const plain = await apiRequest("/api/orders", { method: "POST", cookie: strangerCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(plain.data.id);
  assert.equal((await apiRequest("/api/orders", { cookie: repCookie })).data.rows.some((o) => o.id === plain.data.id), false);
});

test("Vaghinak's order flow chases an app order sooner than an ordinary one", async () => {
  const app = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(app.data.id);
  const plain = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(plain.data.id);
  await pool.query("UPDATE orders SET created_at = now() - interval '3 hours' WHERE id = ANY($1)", [[app.data.id, plain.data.id]]);
  let flow = await orderFlow(pool, 7, { limit: 100000 });
  const a = flow.waiting.find((w) => w.id === app.data.id);
  const b = flow.waiting.find((w) => w.id === plain.data.id);
  assert.equal(a.via_app, true);
  assert.equal(a.sla_h, 2);
  assert.equal(a.over_sla, true, "3 h without confirmation is over the 2 h app limit");
  assert.equal(b.via_app, false);
  assert.equal(b.over_sla, false, "an ordinary order keeps the normal limit");
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { chase_confirm_hours: 6 } });
  flow = await orderFlow(pool, 7, { limit: 100000 });
  assert.equal(flow.waiting.find((w) => w.id === app.data.id).over_sla, false);
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { chase_enabled: false } });
  assert.equal((await orderFlow(pool, 7, { limit: 100000 })).waiting.find((w) => w.id === app.data.id).sla_h, flow.sla.confirm, "switched off: the normal limit");
  await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { chase_enabled: true, chase_confirm_hours: 2 } });
  assert.equal((await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { chase_confirm_hours: 0 } })).status, 400);
});

test("the customer sees that an order waits for KAD Motors' approval (not why), and the customer's own payment terms", async () => {
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const one = async () => (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal((await one()).attention, null);
  await pool.query("UPDATE orders SET credit_status = 'pending' WHERE id = $1", [r.data.id]);
  assert.equal((await one()).attention, "approval");
  await pool.query("UPDATE orders SET credit_status = 'not_required', status = 'draft' WHERE id = $1", [r.data.id]);
  const back = await one();
  assert.equal(back.attention, "returned");
  assert.equal(back.status, "on_hold");
  assert.equal("credit_status" in back || "approval_status" in back, false, "internal approval fields are not passed on");
  await pool.query("UPDATE customers SET credit_term_days = 30 WHERE id = $1", [shop.id]);
  const me = (await apiRequest("/api/partner/me", { cookie: partnerCookie })).data;
  assert.deepEqual(me.terms, { method: "invoice", days: 30 });
  await pool.query("UPDATE customers SET credit_term_days = 45 WHERE id = $1", [shop.id]);
});

test("the customer cancels an order until KAD Motors confirms it; the office is told, the order cannot come back", async () => {
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const one = async () => (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal((await one()).can_edit, true);
  assert.ok((await apiRequest("/api/partner/me", { cookie: partnerCookie })).data.contact.phone, "who to call when it is too late");
  const c = await apiRequest(`/api/partner/orders/${r.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: { reason: "Ordered twice" } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.status, "cancelled");
  assert.equal(c.data.can_edit, false);
  assert.equal(c.data.cancel_reason, "Ordered twice");
  assert.equal(c.data.attention, null);
  // staff: the record stays, marked, and it can neither be edited nor sent forward again
  const staff = (await apiRequest(`/api/orders/${r.data.id}`, { cookie: adminCookie })).data;
  assert.ok(staff.cancelled_at);
  assert.equal((await apiRequest(`/api/orders/${r.data.id}/submit`, { method: "POST", cookie: adminCookie })).data.code, "cancelled_by_customer");
  assert.equal((await apiRequest(`/api/orders/${r.data.id}`, { method: "PATCH", cookie: adminCookie, body: { note: "x" } })).status, 409);
  assert.ok(staff.history.some((h) => /Cancelled by the customer/.test(h.reason ?? "")));
  // a second cancel is a clean refusal, not an error
  const again = await apiRequest(`/api/partner/orders/${r.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "already_cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const n = await pool.query("SELECT title FROM notifications WHERE user_id = $1 AND title LIKE '%չեղարկեց%' ORDER BY id DESC LIMIT 1", [rep.id]);
  assert.equal(n.rows.length, 1, "the customer's sales manager is told");
  // nobody else's order can be cancelled
  const theirs = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [q(p1, 1)], payment_method: "cash" } });
  trackOrder(theirs.data.id);
  assert.equal((await apiRequest(`/api/partner/orders/${theirs.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: {} })).status, 404, "an ordinary order is not an app order");
  const rivals = await apiRequest("/api/partner/orders", { method: "POST", cookie: (await loginAs(other.email)), body: { items: [q(p1, 1)], payment_method: "invoice", payment_term_days: 45 } });
  trackOrder(rivals.data.id);
  assert.equal((await apiRequest(`/api/partner/orders/${rivals.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: {} })).status, 404, "another customer's order");
});

test("once KAD Motors has confirmed, the app can no longer cancel or change it", async () => {
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const ok = await apiRequest(`/api/orders/${r.data.id}`, { method: "PATCH", cookie: directorCookie, body: { status: "confirmed" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const late = await apiRequest(`/api/partner/orders/${r.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: {} });
  assert.equal(late.status, 409);
  assert.equal(late.data.code, "too_late");
  assert.ok(late.data.contact.phone);
  const change = await order(partnerCookie, [q(p2, 3)], { replaces_order_id: r.data.id });
  assert.equal(change.status, 409);
  assert.equal(change.data.code, "too_late");
  assert.equal((await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data.can_edit, false);
  // the failed change placed nothing
  const mine = (await apiRequest("/api/partner/orders", { cookie: partnerCookie })).data.orders;
  assert.equal(mine.filter((o) => o.items.some((i) => i.product_id === p2.id && i.quantity === 3)).length, 0);
});

test("changing an order: the new one takes its place, the old is closed and linked; a failed change leaves the old order alone", async () => {
  const r = await order(partnerCookie, [q(p1, 1)]);
  trackOrder(r.data.id);
  const bad = await order(partnerCookie, [{ product_id: 999999999, quantity: 1 }], { replaces_order_id: r.data.id });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  const still = (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal(still.status, "received", "the old order is exactly as it was");
  assert.equal(still.can_edit, true);
  const ch = await order(partnerCookie, [q(p1, 2), q(p2, 1)], { replaces_order_id: r.data.id, client_ref: `chg-${stamp}` });
  assert.equal(ch.status, 201, JSON.stringify(ch.data));
  trackOrder(ch.data.id);
  assert.equal(ch.data.replaces.id, r.data.id);
  assert.equal(Number(ch.data.total_amd), Math.round(25000 * 0.98));
  const old = (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
  assert.equal(old.status, "cancelled");
  assert.equal(old.replaced, true);
  assert.equal(old.replaced_by_code, ch.data.order_code);
  // the same request retried (lost response) neither cancels nor creates anything again
  const retry = await order(partnerCookie, [q(p1, 2), q(p2, 1)], { replaces_order_id: r.data.id, client_ref: `chg-${stamp}` });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.id, ch.data.id);
  // the office hears of ONE change, with the old number
  await new Promise((resolve) => setTimeout(resolve, 400));
  const n = await pool.query("SELECT title, body FROM notifications WHERE user_id = $1 AND title LIKE '%փոխվեց%' ORDER BY id DESC LIMIT 1", [director.id]);
  assert.ok(n.rows[0]?.body.includes(r.data.order_code));
});

test("the supplier can switch cancel/change off: the app is then told to call", async () => {
  const off = await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { customer_edit_enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  try {
    const r = await order(partnerCookie, [q(p1, 1)]);
    trackOrder(r.data.id);
    const one = (await apiRequest(`/api/partner/orders/${r.data.id}`, { cookie: partnerCookie })).data;
    assert.equal(one.can_edit, false);
    const c = await apiRequest(`/api/partner/orders/${r.data.id}/cancel`, { method: "POST", cookie: partnerCookie, body: {} });
    assert.equal(c.status, 403);
    assert.equal(c.data.code, "edit_disabled");
    assert.equal((await order(partnerCookie, [q(p1, 1)], { replaces_order_id: r.data.id })).status, 403);
    assert.equal((await apiRequest("/api/partner/me", { cookie: partnerCookie })).data.perks.customer_edit, false);
  } finally {
    await apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body: { customer_edit_enabled: true } });
  }
});

test("customer accounts are made from the app: role customer, one connection code, new code signs the old one out, removing switches it off", async () => {
  const erp = `KA${String(stamp).slice(-7)}`;
  const email = `kados-${erp.toLowerCase()}@kados.local`;
  const cust = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erp, name: `KOS Acc ${stamp}` });
  // this test logs in a lot (right and wrong): the login limiter is told to let it through, as the browser tests do
  const prevToken = process.env.E2E_RATE_LIMIT_BYPASS_TOKEN;
  process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "kos-accounts-test";
  const login = (email, password) => apiRequest("/api/auth/login", { method: "POST", body: { email, password }, headers: { "x-e2e-rate-limit-bypass": "kos-accounts-test" } });
  const decode = (code) => JSON.parse(Buffer.from(code, "base64url").toString());
  let userId;
  try {
    assert.equal((await apiRequest("/api/app-orders/accounts", { method: "POST", cookie: repCookie, body: { customer_id: cust.id } })).status, 403, "only admin / CEO");
    const noErp = await createCustomer({ created_by: admin.id, name: `KOS NoErp ${stamp}` });
    assert.equal((await apiRequest("/api/app-orders/accounts", { method: "POST", cookie: adminCookie, body: { customer_id: noErp.id } })).status, 400);
    await pool.query("DELETE FROM customers WHERE id = $1", [noErp.id]);

    const made = await apiRequest("/api/app-orders/accounts", { method: "POST", cookie: adminCookie, body: { customer_id: cust.id } });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    userId = made.data.account.user_id;
    const c1 = decode(made.data.account.code);
    assert.equal(c1.e, email);
    assert.match(c1.u, /^https?:\/\/.+/, "this app's own address is inside the code");
    assert.ok(c1.p.length >= 20);
    assert.equal((await pool.query("SELECT role FROM users WHERE id = $1", [userId])).rows[0].role, "customer");
    assert.equal((await apiRequest("/api/app-orders/accounts", { method: "POST", cookie: adminCookie, body: { customer_id: cust.id } })).status, 409, "one account per customer");

    // the code signs in and reaches only the partner API
    const cookie = (await login(c1.e, c1.p)).cookie;
    const me = await apiRequest("/api/partner/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.customer.id, cust.id);
    assert.equal((await apiRequest("/api/customers", { cookie })).data.code, "partner_only");
    // an app order from it works like any other app order
    const o = await apiRequest("/api/partner/orders", { method: "POST", cookie, body: { items: [{ product_id: p1.id, quantity: 1 }], payment_method: "invoice", payment_term_days: 45 } });
    assert.equal(o.status, 201, JSON.stringify(o.data));
    trackOrder(o.data.id);
    assert.equal(o.data.placed_via_app, true);

    // never in the Team list, and not creatable / assignable as an ordinary role
    assert.ok(!(await apiRequest("/api/users", { cookie: adminCookie })).data.some((u) => u.id === userId));
    assert.equal((await apiRequest("/api/users", { method: "POST", cookie: adminCookie, body: { email: `x-${stamp}@kad.test`, password: "Password-123!", name: "X", role: "customer" } })).status, 400);
    const links = (await apiRequest("/api/app-orders/settings", { cookie: adminCookie })).data.links;
    assert.equal(links.find((l) => l.user_id === userId).user_role, "customer");

    // a new code: new password, the old one and its session stop working
    const again = await apiRequest(`/api/app-orders/accounts/${userId}/code`, { method: "POST", cookie: adminCookie });
    assert.equal(again.status, 200);
    const c2 = decode(again.data.account.code);
    assert.notEqual(c2.p, c1.p);
    assert.equal((await login(c1.e, c1.p)).status, 401);
    assert.equal((await apiRequest("/api/partner/me", { cookie })).status, 401, "the old session is signed out");
    const cookie2 = (await login(c2.e, c2.p)).cookie;
    assert.equal((await apiRequest("/api/partner/me", { cookie: cookie2 })).status, 200);
    assert.equal((await apiRequest(`/api/app-orders/accounts/${admin.id}/code`, { method: "POST", cookie: adminCookie })).status, 404, "only a customer account");

    // removing access: unlinked and switched off, the history stays
    assert.equal((await apiRequest(`/api/app-orders/links/${userId}`, { method: "DELETE", cookie: adminCookie })).status, 200);
    assert.equal((await login(c2.e, c2.p)).status, 403);
    assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE user_id = $1", [userId])).rows[0].n, 1);
    // ... and giving access again brings the same account back with a fresh password
    const back = await apiRequest("/api/app-orders/accounts", { method: "POST", cookie: adminCookie, body: { customer_id: cust.id } });
    assert.equal(back.status, 201);
    assert.equal(back.data.account.user_id, userId);
    const c3 = decode(back.data.account.code);
    assert.equal((await apiRequest("/api/partner/me", { cookie: (await login(c3.e, c3.p)).cookie })).status, 200);
  } finally {
    if (prevToken === undefined) delete process.env.E2E_RATE_LIMIT_BYPASS_TOKEN; else process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = prevToken;
    await pool.query("DELETE FROM orders WHERE customer_id = $1", [cust.id]);
    await pool.query("DELETE FROM partner_links WHERE customer_id = $1", [cust.id]);
    await pool.query("DELETE FROM users WHERE email = $1", [email]);
    await pool.query("DELETE FROM customers WHERE id = $1", [cust.id]);
  }
});

test("the catalog is in KAD Motors' own product order: brand, line, viscosity, then size; non-oil last", async () => {
  const mk = async (name, unit, brand, family) => {
    const p = await createProduct({ name: `${name} ${stamp}`, unit });
    await pool.query("UPDATE products SET brand = $2, family = $3, bronze_price_amd = 1000, silver_price_amd = 1000, stock_qty = 5 WHERE id = $1", [p.id, brand, family]);
    return p;
  };
  // created in a shuffled order on purpose
  const brake = await mk("KOS Sort Brake pad", "pcs", "Castrol", "Other");
  const lotos = await mk("KOS Sort 0W-20", "1L", "Lotos", "Edge");
  const c530 = await mk("KOS Sort 5W-30", "1L", "Castrol", "Edge");
  const c020x4 = await mk("KOS Sort 0W-20", "4L", "Castrol", "Edge");
  const c020x1 = await mk("KOS Sort 0W-20", "1L", "Castrol", "Edge");
  const cat = (await apiRequest("/api/partner/catalog", { cookie: partnerCookie })).data;
  const ids = cat.products.map((p) => p.id);
  const mine = [c020x1, c020x4, c530, lotos, brake].map((p) => ids.indexOf(p.id));
  assert.ok(mine.every((i) => i >= 0));
  assert.deepEqual([...mine].sort((a, b) => a - b), mine, "Castrol Edge 0W-20 1L, 4L, then 5W-30, then Lotos, then the non-oil product");
});

test("KAD OS sees only what is in stock and never how many; the order limit per pack size, with the manager's phone", async () => {
  const mk = async (name, unit, stock) => {
    const p = await createProduct({ name: `${name} ${stamp}`, unit });
    await pool.query("UPDATE products SET bronze_price_amd = 1000, silver_price_amd = 1000, unit_price_amd = 1000, net_cost_amd = 500, stock_qty = $2 WHERE id = $1", [p.id, stock]);
    return p;
  };
  const inStock = await mk("KOS Lim 1L", "1L", 100);
  const empty = await mk("KOS Lim 4L empty", "4L", 0);
  const unknown = await mk("KOS Lim 5L unknown", "5L", null);
  const odd = await mk("KOS Lim 18L", "18L", 100);
  const drum = await mk("KOS Lim 208L", "208L", 100);
  const cat = (await apiRequest("/api/partner/catalog", { cookie: partnerCookie })).data.products;
  const byId = new Map(cat.map((p) => [p.id, p]));
  assert.ok(byId.has(inStock.id));
  assert.equal(byId.has(empty.id), false, "out of stock: not shown");
  assert.equal(byId.has(unknown.id), false, "stock unknown: not shown");
  assert.deepEqual([byId.get(inStock.id).max_qty, byId.get(odd.id).max_qty, byId.get(drum.id).max_qty], [48, 12, 4]);
  assert.ok(cat.every((p) => !("available" in p) && !("stock_qty" in p)), "no stock field at all");

  const manager = await pool.query("SELECT u.id FROM users u WHERE u.id = $1", [rep.id]);
  await pool.query("UPDATE users SET phone = '+37433007020' WHERE id = $1", [manager.rows[0].id]);
  const line = (p, q) => ({ product_id: p.id, quantity: q });
  const ok = await order(partnerCookie, [line(inStock, 48)]);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  trackOrder(ok.data.id);
  const over = await order(partnerCookie, [line(inStock, 49)]);
  assert.equal(over.status, 400);
  assert.equal(over.data.code, "order_limit");
  assert.equal(over.data.max_qty, 48);
  assert.equal(over.data.contact.phone, "+37433007020", "the customer's own sales manager");
  assert.equal(over.data.contact.name, rep.name);
  // the same product in two lines counts together; another product has its own limit
  const split = await order(partnerCookie, [line(drum, 3), line(drum, 2)]);
  assert.equal(split.status, 400);
  assert.equal(split.data.max_qty, 4);
  assert.equal((await order(partnerCookie, [line(drum, 4), line(odd, 12)])).status, 201);
  await pool.query("DELETE FROM orders WHERE customer_id = $1 AND created_at > now() - interval '1 minute' AND user_id = $2", [shop.id, partner.id]);
  // the preview refuses it too, so the cart can say so before sending
  const pv = await apiRequest("/api/partner/preview", { method: "POST", cookie: partnerCookie, body: { items: [line(odd, 13)] } });
  assert.equal(pv.status, 400);
  assert.equal(pv.data.code, "order_limit");
  // an ordinary sales manager's order has no limit; the supplier can change the numbers or switch the limits off
  const normal = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: shop.id, items: [line(drum, 9)], payment_method: "cash" } });
  assert.equal(normal.status, 201);
  trackOrder(normal.data.id);
  const put = (body) => apiRequest("/api/app-orders/settings", { method: "PUT", cookie: adminCookie, body });
  assert.equal((await put({ limits: { 4: 0 } })).status, 400);
  assert.equal((await put({ limits: { abc: 5 } })).status, 400);
  try {
    assert.equal((await put({ limits: { 18: 20 }, limit_default: 10 })).status, 200);
    assert.equal((await apiRequest("/api/partner/catalog", { cookie: partnerCookie })).data.products.find((p) => p.id === odd.id).max_qty, 20);
    assert.equal((await put({ limits_enabled: false })).status, 200);
    const free = await order(partnerCookie, [line(drum, 50)]);
    assert.equal(free.status, 201, "limits switched off");
    trackOrder(free.data.id);
    assert.equal((await apiRequest("/api/partner/catalog", { cookie: partnerCookie })).data.products.find((p) => p.id === drum.id).max_qty, null);
  } finally {
    await put({ limits_enabled: true, limit_default: 12, limits: { 1: 48, 4: 16, 5: 16, 7: 12, 60: 4, 180: 4, 205: 4, 208: 4 } });
  }
});
