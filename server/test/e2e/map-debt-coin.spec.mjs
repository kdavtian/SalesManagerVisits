import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-26: an optional small gold coin on the pins of customers who owe money (Off by default, switch in the pin key), and a complete pin key
// (task markers, planned visit, rep ring, route stop, brand dots, me, teammate).
let tileNo = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.789, longitude: 43.847, accuracy: 15 }, permissions: ["geolocation"], deviceScaleFactor: Number(process.env.E2E_DPR ?? 1) });

test("Debt coin: off by default, switch in the pin key puts a coin on debtors only, remembered per user; the key lists every marker", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const stamp = Date.now();
  const erpIds = [];
  const mk = async (name, lat, lng, debt) => {
    const erpId = `E2E-DC-${stamp}-${name.replace(/\s/g, "")}`;
    erpIds.push(erpId);
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name, sales_channel: "SM YVN", lat, lng, erp_customer_id: erpId });
    await pool.query("UPDATE customers SET customer_tier = 'gold' WHERE id = $1", [c.id]);
    await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, 0, now())", [erpId, debt]);
    return c;
  };
  try {
    const c1 = await mk("E2E Coin One", 40.7891, 43.8471, 250000); // small
    await mk("E2E Coin Two", 40.7901, 43.8481, 0); // no coin
    await mk("E2E Coin Three", 40.7911, 43.8491, 500000); // medium
    await mk("E2E Coin Four", 40.7921, 43.8501, 2000000); // large
    await loginViaUi(page, admin.email);
    await page.goto(`/#/map?customer=${c1.id}`);
    await expect(page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator("#leaflet-map .pin-debt")).toHaveCount(0); // Off by default

    await page.locator("#map-legend-btn").click();
    await expect(page.locator("#map-legend-toggle-debt")).toHaveAttribute("aria-checked", "false");
    await page.locator("#map-legend-toggle-debt").click();
    await expect(page.locator("#map-legend-toggle-debt")).toHaveAttribute("aria-checked", "true");
    // a coin on every customer who owes money, none on the one at zero; size and colour by the amount (under 300,000 / under 1,000,000 / 1,000,000 and more)
    await expect(page.locator("#leaflet-map .pin-debt")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator("#leaflet-map .pin-debt-s")).toHaveCount(1);
    await expect(page.locator("#leaflet-map .pin-debt-m")).toHaveCount(1);
    await expect(page.locator("#leaflet-map .pin-debt-l")).toHaveCount(1);
    const sizes = await page.locator("#leaflet-map .pin-debt").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)).sort((a, b) => a - b));
    expect(sizes).toEqual([14, 18, 22]);
    // the key explains it, and every other marker is listed too
    const key = await page.locator("#map-legend-panel").innerText();
    for (const part of [/Small yellow coin/i, /Medium orange coin/i, /Large red coin/i, /Open task, not due yet/i, /due today or overdue/i, /Planned for today/i, /Ring in the rep/i, /Route stop \(number/i, /already visited/i, /Brand filter: available/i, /My location/i, /Teammate/i]) expect(key).toMatch(part);
    await page.locator("#map-legend-panel").evaluate((el) => el.querySelector(".map-legend-body")?.scrollTo(0, 99999));
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/map-key-bottom.png` });
    await page.locator("#map-legend-panel").evaluate((el) => el.querySelector(".map-legend-body")?.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/map-key-top.png` });
    await page.locator("#map-legend-close").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/map-debt-coin.png` });

    // remembered after a reload; switching off removes the coins
    await page.reload();
    await expect(page.locator("#leaflet-map .pin-debt")).toHaveCount(3, { timeout: 20000 });
    await page.locator("#map-legend-btn").click();
    await page.locator("#map-legend-toggle-debt").click();
    await expect(page.locator("#leaflet-map .pin-debt")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  }
});
