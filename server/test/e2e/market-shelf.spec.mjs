import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Reports > Shelf share (owner, 2026-11-26): Castrol share of visited shops, the fake spot, "Show on map" opens the Brands filter picked.
test("shelf share: Castrol share, a fake Castrol spot, show on map; Armenian at 390 and 320 px", async ({ page, fixtures }) => {
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager");
  const admin = await fixtures.createUser("admin");
  const shop = await fixtures.createCustomer({ name: `FakeSpot${stamp}`, created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status)
     VALUES ($1, $2, 40.18, 44.51, 5, true, '{"castrol":["fake"],"competitors":["motul"]}')`,
    [shop.id, rep.id]
  );

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/reports?r=market_shelf");
  const spot = page.locator(".mkt-flag-row", { hasText: `FakeSpot${stamp}` });
  await expect(spot).toBeVisible({ timeout: 15000 });
  await expect(spot).toContainText("Կեղծ Castrol");
  await expect(page.locator(".mkt-trend .mkt-trend-col")).toHaveCount(6);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-shelf-390.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-shelf-320.png`, fullPage: true });
  await page.locator("#mkt-map").click();
  await expect(page).toHaveURL(/#\/map\?brands=castrol:fake/);
  await expect(page.locator('[data-map-filter-btn="brandchips"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-map-filter-btn="brandchips"]')).toHaveClass(/search-filter-btn-active/);
});
