import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Offices (owner, 2026-11-03): standing at an office the app offers "Check in"; the office is a distinct pin on the map.
const AT = { latitude: 40.1912, longitude: 44.5121 };

test.use({ geolocation: AT, permissions: ["geolocation"] });

test.describe.configure({ mode: "serial" });
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("@iphone office banner appears at the office and check-in opens the office check-in", async ({ page, fixtures }) => {
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const office = await fixtures.createCustomer({ created_by: admin.id, name: "E2E Head office Baghramyan 21", lat: AT.latitude, lng: AT.longitude });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [office.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  await page.goto("/#/dashboard");
  const banner = page.locator("#office-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText("Head office Baghramyan 21");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/office-banner.png` });
  await banner.locator('[data-act="checkin"]').click();
  await expect(page).toHaveURL(new RegExp(`#/checkin/${office.id}`));
});

test("@iphone the office is a distinct pin on the map, whatever channel filter is on", async ({ page, fixtures }) => {
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const office = await fixtures.createCustomer({ created_by: admin.id, name: "E2E Office Gajegortsner 74", lat: AT.latitude, lng: AT.longitude });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [office.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/map?customer=${office.id}`);
  await expect(page.locator("#leaflet-map .pin-office").first()).toBeVisible({ timeout: 20000 });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/office-map.png` });
});
