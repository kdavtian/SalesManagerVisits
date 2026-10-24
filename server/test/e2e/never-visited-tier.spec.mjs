import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: (1) the price-tier coin says T1 / T2 / T3 (bronze / silver / gold); (2) a "!" marks places that were never visited, in the plan
// customer lists and on the map pins.
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("map pin and plan list: '!' only on the never-visited customer; the tier coin reads T1 / T2 / T3", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const stamp = Date.now();
  const fresh = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Never Visited Shop", sales_channel: "SM YVN", lat: 40.1851, lng: 44.5201, erp_customer_id: `E2E-NV-${stamp}-a` });
  const seen = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Visited Shop", sales_channel: "SM YVN", lat: 40.1861, lng: 44.5211, erp_customer_id: `E2E-NV-${stamp}-b` });
  await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.1861, 44.5211, 3, true)", [seen.id, rep.id]);
  await pool.query("UPDATE customers SET customer_tier = 'gold' WHERE id = $1", [fresh.id]);
  await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = $1", [seen.id]);
  try {
    // the map
    await loginViaUi(page, rep.email);
    await page.goto(`/#/map?customer=${fresh.id}`);
    await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator("#leaflet-map .pin-never")).toHaveCount(1);
    await expect(page.locator("#leaflet-map .leaflet-marker-icon", { has: page.locator(".pin-never") })).toHaveCount(1);

    // the tier coin on the customer card
    await page.goto(`/#/customers/${fresh.id}`);
    await expect(page.locator(".tier-badge").first()).toContainText("T3", { timeout: 15000 });
    await page.goto(`/#/customers/${seen.id}`);
    await expect(page.locator(".tier-badge").first()).toContainText("T1", { timeout: 15000 });

    // the plan customer list (admin opens the rep's Monday)
    await page.context().clearCookies();
    await loginViaUi(page, admin.email);
    await page.goto("/#/route-plans");
    const card = page.locator(".route-plan-rep-card", { hasText: rep.name });
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator('.route-plan-day-chip[data-day="1"]').click();
    const list = page.locator("#route-plan-customer-list");
    await expect(list).toContainText("E2E Never Visited Shop", { timeout: 10000 });
    await list.locator(".route-plan-tree-row[data-toggle]").first().click().catch(() => {});
    const never = list.locator(".route-plan-tree-row-leaf", { hasText: "E2E Never Visited Shop" });
    const done = list.locator(".route-plan-tree-row-leaf", { hasText: /^\s*E2E Visited Shop/ });
    await expect(never.locator(".never-visited-mark")).toHaveCount(1);
    await expect(done.locator(".never-visited-mark")).toHaveCount(0);
    await page.screenshot({ path: `${process.env.NV_SHOTS ?? "/tmp"}/nv-plan.png` });
  } finally {
    await pool.query("DELETE FROM checkins WHERE user_id = $1", [rep.id]);
  }
});
