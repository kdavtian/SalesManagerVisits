// Reports > Competitor prices (GET /api/market/prices) and the monthly price-drop alert (priceAlerts.checkPriceDrops). Made-up names only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { checkPriceDrops } from "../../src/reports/market/priceAlerts.js";

const brand = `zt${Date.now().toString(36)}`;
let rep, admin, cookies = {}, shops = [], product;
const checkinIds = [];
async function price(shop, o) {
  const { rows: [ch] } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range) VALUES ($1, $2, $3, 40.18, 44.51, 5, true) RETURNING id`,
    [shop.id, rep.id, o.at]
  );
  checkinIds.push(ch.id);
  await pool.query(
    `INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd, recorded_at)
     VALUES ($1, $2, $3, $4, 'pcmo_0w30', 4, 'L', $5, $6, $7)`,
    [ch.id, shop.id, rep.id, brand, o.w ?? null, o.r ?? null, o.at]
  );
}

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  admin = await createUser("admin");
  for (const [k, u] of Object.entries({ rep, admin })) cookies[k] = await loginAs(u.email);
  await pool.query("INSERT INTO competitor_brands (key, name, status) VALUES ($1, $2, 'approved')", [brand, `Zt ${brand}`]);
  for (let i = 0; i < 3; i++) shops.push(await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 }));
  product = await createProduct({ name: `Castrol EDGE 0W-30 ${brand}`, unit: "4L" });
  await pool.query("UPDATE products SET brand = 'Castrol', size_l = 4, bronze_price_amd = 22000, silver_price_amd = 21000, gold_price_amd = 20000, retail_price_amd = 27000 WHERE id = $1", [product.id]);
  const recent = (d) => new Date(Date.now() - d * 86400000).toISOString();
  await price(shops[0], { w: 20000, r: 25000, at: recent(3) });
  await price(shops[1], { w: 20000, r: 24000, at: recent(4) });
  await price(shops[2], { w: 25000, r: 24000, at: recent(5) }); // retail < wholesale: flagged, out
  // an old drop, for the alert: Feb 2025 10,000 -> Mar 2025 9,000
  await price(shops[0], { w: 10000, at: "2025-02-05T09:00:00Z" });
  await price(shops[1], { w: 10000, at: "2025-02-06T09:00:00Z" });
  await price(shops[0], { w: 9000, at: "2025-03-05T09:00:00Z" });
  await price(shops[1], { w: 9000, at: "2025-03-06T09:00:00Z" });
});
test.after(async () => {
  await pool.query("DELETE FROM checkins WHERE id = ANY($1::int[])", [checkinIds]);
  await pool.query("DELETE FROM competitor_brands WHERE key = $1", [brand]);
  await pool.query("DELETE FROM notifications WHERE type = 'market_price_drop' AND body LIKE $1", [`%${brand}%`]);
  await cleanupAll();
  await stopTestServer();
});

test("the index: our product beside the brand's clean medians, gap and margins; a rep may not open it", async () => {
  const r = await apiRequest("/api/market/prices", { cookie: cookies.admin });
  assert.equal(r.status, 200);
  const g = r.data.groups.find((x) => x.line_code === "pcmo_0w30" && x.volume === 4);
  const b = g.brands.find((x) => x.brand_key === brand);
  assert.deepEqual([b.wholesale, b.retail, b.margin, b.meta.shops], [20000, 24500, 4500, 2]);
  const ours = g.ours.find((p) => p.id === product.id);
  assert.deepEqual([ours.bronze, ours.retail, ours.margin_bronze], [22000, 27000, 5000]);
  if (g.reference_id === product.id) assert.equal(b.gap_wholesale_pct, 10);
  assert.equal((await apiRequest("/api/market/prices", { cookie: cookies.rep })).status, 403);
});

test("the monthly alert: admin gets the drop once", async () => {
  const sent = await checkPriceDrops(new Date("2025-04-02T08:00:00Z"));
  assert.ok(sent >= 1);
  const { rows } = await pool.query("SELECT title, body, url FROM notifications WHERE user_id = $1 AND type = 'market_price_drop'", [admin.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /\(2025-03\)/);
  assert.match(rows[0].body, new RegExp(`Zt ${brand} .* 4 լ: մեծ\\. 10,000 → 9,000 դր \\(-10%, 2 խանութ\\)`));
  assert.equal(rows[0].url, "/#/reports?r=market_prices");
  assert.equal(await checkPriceDrops(new Date("2025-04-03T08:00:00Z")), 0, "once a month");
});
