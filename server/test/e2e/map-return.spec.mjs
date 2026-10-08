import { test, expect, loginViaUi } from "./fixtures.mjs";

// Regression: with a saved map view at the usual GPS zoom (15), mapSafeRuntime's
// "preserve the restored viewport" shortcut swallowed the map's own first
// setView, so the Map tab came back as a blank grey area with working buttons
// until the app was restarted (sessionStorage cleared).
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("Map tab", () => {
  test("returning to the Map with a saved view at zoom 15 still draws the map", async ({ page, fixtures }) => {
    await page.route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
    const user = await fixtures.createUser("sales_manager");
    await loginViaUi(page, user.email);

    await page.evaluate(() => {
      sessionStorage.setItem("fv_map_view", JSON.stringify({ center: [40.18, 44.51], zoom: 15 }));
      sessionStorage.setItem("kad.fieldVisits.mapView.v2", JSON.stringify({ lat: 40.18, lng: 44.51, zoom: 15, bearing: 0, savedAt: Date.now() }));
    });
    await page.evaluate(() => (location.hash = "#/map"));
    await expect(page.locator("#leaflet-map")).toBeVisible();
    await expect.poll(() => page.locator("#leaflet-map .leaflet-tile").count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Leave and come back: still drawn.
    await page.evaluate(() => (location.hash = "#/customers"));
    await expect(page.locator("#leaflet-map")).toHaveCount(0);
    await page.evaluate(() => (location.hash = "#/map"));
    await expect.poll(() => page.locator("#leaflet-map .leaflet-tile").count(), { timeout: 10000 }).toBeGreaterThan(0);
  });
});
