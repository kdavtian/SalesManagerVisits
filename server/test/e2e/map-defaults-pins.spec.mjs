import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-03: the map shows every direction and rep by default (no channel filter), and the pins of competitors and of the CVO / OEM / PCO / CAS / KF
// channels are about 35% smaller than the field customers' pins.
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("Map: all channels shown by default, non-field channel pins 35% smaller", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const stamp = Date.now();
  const mk = async (name, channel, lat, lng) => {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name, sales_channel: channel, lat, lng, erp_customer_id: `E2E-MD-${stamp}-${name.replace(/\s/g, "")}` });
    await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = $1", [c.id]);
    return c;
  };
  const sm = await mk("E2E Pin SM", "SM YVN", 40.1851, 44.5201);
  await mk("E2E Pin KF", "KF", 40.1861, 44.5211);
  await mk("E2E Pin B2B", "SM B2B", 40.1871, 44.5221);
  await loginViaUi(page, admin.email);
  await page.goto(`/#/map?customer=${sm.id}`);
  const imgs = page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon) img.pin-img-asset");
  await expect(imgs).toHaveCount(3, { timeout: 20000 }); // KF and SM B2B are on the map without touching any filter
  const widths = await imgs.evaluateAll((els) => els.map((e) => Number(e.getAttribute("width"))).sort((a, b) => a - b));
  expect(widths).toEqual([27, 41, 41]); // KF 41 * 0.65, the two others full size
});

// Owner, 2026-11-03: "split overdue everywhere" -- on the map, Overdue and Never visited are two chips with their own pins.
test("Map: Overdue and Never visited are separate filters", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const stamp = Date.now();
  const mk = async (name, lat, lng) => {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name, sales_channel: "SM YVN", lat, lng, erp_customer_id: `E2E-NV-${stamp}-${name.replace(/\s/g, "")}` });
    await pool.query("UPDATE customers SET customer_tier = 'bronze', visit_frequency_days = 7 WHERE id = $1", [c.id]);
    return c;
  };
  const never = await mk("E2E Never One", 40.1851, 44.5201);
  const late = await mk("E2E Late One", 40.1861, 44.5211);
  const rep = await fixtures.createUser("sales_manager"); // only a rep's check-in counts as a field visit
  await pool.query("INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range) VALUES ($1, $2, now() - interval '30 days', 40.1861, 44.5211, 3, true)", [late.id, rep.id]);
  await loginViaUi(page, admin.email);
  await page.goto(`/#/map?customer=${never.id}`);
  const pins = page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon) img.pin-img-asset");
  await expect(pins).toHaveCount(2, { timeout: 20000 });
  await page.locator(".map-primary-filter-wrap .activity-search-filter-btn").click();
  await page.locator('.map-filter-chip[data-filter="never"]').click();
  await expect(pins).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator("#leaflet-map .pin-is-never")).toHaveCount(1);
  await page.locator(".map-primary-filter-wrap .activity-search-filter-btn").click();
  await page.locator('.map-filter-chip[data-filter="overdue"]').click();
  await expect(pins).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator("#leaflet-map .pin-is-never")).toHaveCount(0);
  await expect(page.locator("#leaflet-map .pin-status-overdue")).toHaveCount(1);
});
