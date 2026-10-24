import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: the map's "i" panel has a "Colour by: Tier | Rep" switch (default Tier, remembered per user); in Rep mode every pin gets a ring in its rep's colour;
// the admin picks each rep's colour in Team management.
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("Colour by Rep: default Tier, ring per rep colour, remembered per user; colour picked in Team management", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const aram = await fixtures.createUser("sales_manager", { name: "E2E Aram Rep" });
  const narek = await fixtures.createUser("sales_manager", { name: "E2E Narek Rep" });
  await pool.query("UPDATE users SET map_color = '#0a69da' WHERE id = $1", [aram.id]);
  const stamp = Date.now();
  const mk = async (name, mgr, lat, lng, tier) => {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: mgr.id, name, sales_channel: "SM YVN", lat, lng, erp_customer_id: `E2E-CB-${stamp}-${name.replace(/\s/g, "")}` });
    await pool.query("UPDATE customers SET customer_tier = $2 WHERE id = $1", [c.id, tier]);
    return c;
  };
  const c1 = await mk("E2E Color One", aram, 40.1851, 44.5201, "gold");
  await mk("E2E Color Two", aram, 40.1861, 44.5211, "potential");
  await mk("E2E Color Three", narek, 40.1871, 44.5221, "bronze");
  await loginViaUi(page, admin.email);
  await page.goto(`/#/map?customer=${c1.id}`);
  await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#leaflet-map .pin-rep-ring")).toHaveCount(0); // Tier by default
  await page.locator("#map-legend-btn").click();
  await expect(page.locator('[data-color-by="tier"]')).toHaveClass(/chip-active/);
  // the switch sits between "Group nearby pins" and "Compass"
  const order = await page.evaluate(() => [...document.querySelectorAll(".map-legend-prefs > *")].map((el) => el.id || el.className || el.textContent.trim().slice(0, 20)));
  const labels = await page.locator(".map-legend-prefs .map-legend-pref-row > span").allInnerTexts();
  expect(labels[0]).toMatch(/Group nearby pins/i);
  expect(labels[1]).toMatch(/Colour by/i);
  expect(labels[2]).toMatch(/Compass/i);
  await page.locator('[data-color-by="rep"]').click();
  await expect(page.locator("#leaflet-map .pin-rep-ring")).toHaveCount(3, { timeout: 10000 });
  const colors = await page.locator("#leaflet-map .pin-rep-ring").evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopColor));
  expect(colors.filter((c) => c === "rgb(10, 105, 218)").length).toBe(2); // Aram's chosen blue, two pins
  expect(new Set(colors).size).toBe(2); // Narek: an automatic colour, different from Aram's
  await expect(page.locator("#map-rep-legend")).toContainText("E2E Aram Rep");
  await expect(page.locator("#map-rep-legend")).toContainText("E2E Narek Rep");
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/map-rep.png` });
  await page.locator("#map-legend-close").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/map-rep-pins.png` });

  // remembered after a reload; another user starts on Tier
  await page.reload();
  await expect(page.locator("#leaflet-map .pin-rep-ring")).toHaveCount(3, { timeout: 20000 });
  await page.context().clearCookies();
  const other = await fixtures.createUser("admin");
  await loginViaUi(page, other.email);
  await page.goto(`/#/map?customer=${c1.id}`);
  await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#leaflet-map .pin-rep-ring")).toHaveCount(0);

  // Team management: the admin picks Narek's colour
  await page.context().clearCookies();
  await loginViaUi(page, admin.email);
  await page.goto("/#/settings?section=a-team");
  await page.locator("#row-team-management").click();
  await page.locator("#user-list .list-row", { hasText: "E2E Narek Rep" }).click();
  await page.locator('.team-swatch[data-color="#8e44ad"]').click();
  await page.locator('#edit-user-form button[type="submit"]').click();
  await expect.poll(async () => (await pool.query("SELECT map_color FROM users WHERE id = $1", [narek.id])).rows[0].map_color).toBe("#8e44ad");
  await expect(page.locator("#user-list .list-row", { hasText: "E2E Narek Rep" }).locator(".team-color-dot")).toBeVisible();
});
