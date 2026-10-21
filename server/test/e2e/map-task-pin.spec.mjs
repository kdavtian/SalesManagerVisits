import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-22: tap a pin that has a task icon -> More -> complete the task on the customer card -> Back to the map:
// the task icon has to be gone from the pin and the pin has to stay selected (popup open, halo on).
let tileNo = 0; // tiles of different sizes: the map treats identical-size tiles as the provider's "blocked" placeholder image
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("map: completing the customer's task on the card removes the task icon from the pin and keeps the pin selected", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Task Pin Shop", sales_channel: "SM YVN", lat: 40.1851, lng: 44.5201 });
  const { rows } = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ('E2E pin task', $1, $1, $2, current_date) RETURNING id",
    [rep.id, customer.id]
  );
  const taskId = rows[0].id;
  try {
    await loginViaUi(page, rep.email);
    await page.goto(`/#/map?customer=${customer.id}`);
    const pin = page.locator("#leaflet-map .leaflet-marker-icon", { has: page.locator(".pin-task") });
    await expect(pin).toHaveCount(1, { timeout: 20000 });
    await pin.click(); // the rep taps the pin
    await expect(page.locator(".leaflet-popup-content")).toHaveCount(1);
    await expect(page.locator(".leaflet-popup-content")).toContainText("E2E Task Pin Shop");
    await expect(page.locator("#leaflet-map .leaflet-marker-icon.kad-marker-selected")).toHaveCount(1);

    await page.locator('.leaflet-popup-content [data-action="details"]').click();
    await expect(page.locator("#edit-customer-btn")).toBeVisible();
    // complete the task the way the card does (same endpoint), then come back
    await page.evaluate(async (id) => {
      const csrf = document.cookie.match(/csrf[^=]*=([^;]+)/)?.[1];
      const r = await fetch(`/api/tasks/${id}/complete`, { method: "POST", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}) }, body: "{}", credentials: "same-origin" });
      if (!r.ok) throw new Error(`complete failed ${r.status}`);
    }, taskId);
    await page.goBack();

    await expect(page.locator(".leaflet-popup-content")).toHaveCount(1, { timeout: 10000 }); // the old popup is gone, one is reopened
    await expect(page.locator(".leaflet-popup-content")).toContainText("E2E Task Pin Shop"); // still selected: popup reopened
    await expect(page.locator("#leaflet-map .pin-task")).toHaveCount(0); // the task icon is gone from the pin
    await expect(page.locator("#leaflet-map .leaflet-marker-icon.kad-marker-selected")).toHaveCount(1); // and the selection halo is on
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  }
});
