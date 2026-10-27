import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-23: the rep's own location dot is drawn ABOVE the customers' pins, and never blocks tapping the pin underneath.
let tileNo = 0; // tiles of different sizes: identical-size tiles look like the provider's "blocked" placeholder to the map
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("map: my location sits in a pane above the customer pins and the pin under it is still tappable", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const rep = await fixtures.createUser("sales_manager");
  // the customer stands exactly where the rep stands
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Under Me Shop", sales_channel: "SM YVN", lat: 40.185, lng: 44.52 });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/map?customer=${customer.id}`);
  await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
  await page.locator("#locate-btn").click().catch(() => {});

  const dot = page.locator("#leaflet-map .leaflet-me-pane .me-dot");
  await expect(dot).toHaveCount(1, { timeout: 20000 });
  const z = await page.evaluate(() => ({
    me: Number(getComputedStyle(document.querySelector(".leaflet-me-pane")).zIndex),
    pins: Number(getComputedStyle(document.querySelector(".leaflet-marker-pane")).zIndex),
    pointer: getComputedStyle(document.querySelector(".leaflet-me-pane")).pointerEvents,
  }));
  expect(z.me).toBeGreaterThan(z.pins);
  expect(z.pointer).toBe("none");
  // ...but under an open customer card (owner, 2026-10-27: the dot showed through the card). Same parent pane (the rotate plugin's), so
  // the z-indexes compare; teammates sit between the pins and me.
  const layers = await page.evaluate(() => {
    const pane = (n) => document.querySelector(`.leaflet-${n}-pane`);
    return {
      sameParent: pane("me").parentElement === pane("popup").parentElement && pane("team").parentElement === pane("marker").parentElement,
      me: Number(getComputedStyle(pane("me")).zIndex),
      team: Number(getComputedStyle(pane("team")).zIndex),
      popup: Number(getComputedStyle(pane("popup")).zIndex),
    };
  });
  expect(layers.sameParent).toBe(true);
  expect(layers.popup).toBeGreaterThan(layers.me);
  expect(layers.me).toBeGreaterThan(layers.team);
  expect(layers.team).toBeGreaterThan(z.pins);

  // tapping where both stand still reaches the customer's pin
  const box = await dot.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".leaflet-popup-content")).toContainText("E2E Under Me Shop", { timeout: 10000 });
});
