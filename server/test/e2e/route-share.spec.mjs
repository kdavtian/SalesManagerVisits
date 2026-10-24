import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner idea, 2026-10-24: one tap sends today's route (the planned stops + a Google Maps link) to Telegram.
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"], viewport: { width: 390, height: 844 } });

test("the planned-stops panel has a Telegram share button that sends the stops and the Maps link", async ({ page, fixtures }) => {
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Route Rep" });
  const stamp = Date.now();
  const ids = [];
  for (const [i, name] of ["E2E Route Alpha", "E2E Route Beta", "E2E Route Gamma"].entries()) {
    const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name, sales_channel: "SM YVN", lat: 40.185 + i * 0.001, lng: 44.52 + i * 0.001, erp_customer_id: `E2E-RS-${stamp}-${i}` });
    ids.push(c.id);
  }
  await loginViaUi(page, rep.email);
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await pool.query("INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, $2, $3, 'approved', $1)", [rep.id, today, ids]);
  try {
    await page.goto("/#/map");
    await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
    await page.locator(".map-primary-filter-wrap > .activity-search-filter-btn").click(); // the filter menu
    await page.locator('.map-filter-chip[data-filter="planned"]').click();
    await expect(page.locator("#planned-stops-panel")).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${process.env.RS_SHOTS ?? "/tmp"}/route-share-panel.png` });

    let sharedUrl = "";
    await page.context().route(/t\.me\/share/, (route) => {
      sharedUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>telegram</body></html>" });
    });
    const [popup] = await Promise.all([page.context().waitForEvent("page"), page.locator("#share-route-btn").click()]);
    await expect.poll(() => sharedUrl).not.toBe("");
    const url = decodeURIComponent(sharedUrl);
    expect(url).toContain("t.me/share/url");
    expect(url).toContain("E2E Route Rep");
    expect(url).toMatch(/1\. E2E Route Alpha\n2\. E2E Route Beta\n3\. E2E Route Gamma/);
    expect(url).toContain("https://www.google.com/maps/dir/");
    await popup.close();
  } finally {
    await pool.query("DELETE FROM visit_plans WHERE user_id = $1", [rep.id]);
  }
});
