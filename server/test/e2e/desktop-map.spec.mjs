import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 8: on a desktop window the Map's side list is a table (customer, channel, debt, last visit, planned
// today) that sorts by a header tap; a row pans to the pin and opens its popup, which shows Debt and Last order; "Only the visible
// area" keeps the rows to the pins on screen. Above 1400 px the filters are a bar above the map and the pin key is a right panel that
// stays open while the map is used. A phone keeps its own map.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==", "base64");

test("desktop Map: side table, row opens the popup, visible area, key panel, filter bar", async ({ page, fixtures }) => {
  // map tiles are third-party: answer them locally (different sizes, so the "blocked provider" check does not fire)
  await page.context().route(/^https:\/\/.*\.png/, (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(1 + Math.floor(Math.random() * 400))]), headers: { "access-control-allow-origin": "*" } })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const erp = `MAPT${stamp}`;
  await fixtures.createCustomer({ name: `MapNear${stamp}`, sales_channel: "SM YVN", created_by: admin.id, lat: 40.18, lng: 44.51, erp_customer_id: erp });
  await fixtures.createCustomer({ name: `MapFar${stamp}`, sales_channel: "SM YVN", created_by: admin.id, lat: 40.6, lng: 44.95 });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 1234567)", [erp]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, '2026-10-02', 1000)", [erp, `O${stamp}`]);
  try {
    await loginViaUi(page, admin.email);
    await page.evaluate(() => {
      localStorage.removeItem("fieldvisits_map_visible_only");
      localStorage.removeItem("fieldvisits_map_side_sort");
    });
    await page.goto("/#/map");
    const table = page.locator(".map-side-table");
    await expect(table.locator(".mst-row").first()).toBeVisible({ timeout: 20000 });

    // narrow to this test's two customers
    await page.locator("#map-customer-search").fill(`${stamp}`);
    await expect(table.locator(".mst-row")).toHaveCount(2, { timeout: 15000 });
    await page.locator("#map-customer-search").press("Escape");
    await expect(page.locator("#map-address-results")).toBeHidden();

    // debt column, and a debt sort puts the debtor first (tap again: reversed)
    await table.locator('.mst-th[data-sort="debt"]').click();
    await expect(table.locator(".mst-row").first()).toContainText(`MapNear${stamp}`);
    await expect(table.locator(".mst-row").first().locator(".mst-debt")).toHaveText("1,234,567");
    await table.locator('.mst-th[data-sort="debt"]').click();
    await expect(table.locator(".mst-row").first()).toContainText(`MapFar${stamp}`);

    // a row pans to the pin and opens its popup, with Debt and Last order
    await table.locator(".mst-row", { hasText: `MapNear${stamp}` }).click();
    const popup = page.locator(".leaflet-popup .map-popup");
    await expect(popup).toContainText(`MapNear${stamp}`, { timeout: 15000 });
    await expect(popup).toContainText("1,234,567");
    await expect(popup).toContainText("Last order");
    await expect(popup).toContainText("2 Oct");
    await expect(table.locator(".mst-row.is-active")).toContainText(`MapNear${stamp}`);

    // zoomed in on the near shop: "Only the visible area" drops the far one
    for (let i = 0; i < 4; i += 1) await page.locator("#zoom-in-btn").click();
    await table.locator(".mst-visible-input").check();
    await expect(table.locator(".mst-row")).toHaveCount(1);
    await expect(table.locator(".mst-row")).toContainText(`MapNear${stamp}`);
    await table.locator(".mst-visible-input").uncheck();
    await expect(table.locator(".mst-row")).toHaveCount(2);

    // the filter bar: status choices as visible chips above the map
    const overdueChip = page.locator('.map-search-filter-menu [data-filter="overdue"]');
    await expect(overdueChip).toBeVisible();
    const bar = await page.locator(".map-top-controls").boundingBox();
    const mapBox = await page.locator("#leaflet-map").boundingBox();
    expect(mapBox.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);

    // the pin key: a panel on the right that stays open while the map is clicked
    await page.locator("#map-legend-btn").click();
    const key = page.locator("#map-legend-panel");
    await expect(key).toBeVisible();
    const keyBox = await key.boundingBox();
    expect(Math.round(keyBox.x + keyBox.width)).toBe(1440);
    await page.mouse.click(mapBox.x + 60, mapBox.y + mapBox.height - 60);
    await expect(key).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-map.png` });
    await key.locator("#map-legend-close").click();
    await expect(key).toBeHidden();

    // phone: no side table
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#map-side-list")).toBeHidden();
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erp]);
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erp]);
  }
});
