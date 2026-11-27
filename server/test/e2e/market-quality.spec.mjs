import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Reports > Market data quality (owner, 2026-11-26): per rep score, shelf / price shares, the flagged price entries (tap = the shop).
test("market data quality: rep rows with a score and a flagged price, Armenian at 390 and 320 px", async ({ page, fixtures }) => {
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager", { name: `MqRep${stamp}` });
  const admin = await fixtures.createUser("admin");
  const shop = await fixtures.createCustomer({ name: `MqShop${stamp}`, created_by: rep.id, assigned_manager_id: rep.id });
  const { rows: [ch] } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status)
     VALUES ($1, $2, 40.18, 44.51, 5, true, '{"castrol":["available"]}') RETURNING id`,
    [shop.id, rep.id]
  );
  await pool.query(
    `INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd)
     VALUES ($1, $2, $3, 'motul', 'pcmo_5w40', 4, 'L', 22000, 18000)`,
    [ch.id, shop.id, rep.id]
  );

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/reports");
  await expect(page.locator('.report-list-card[data-key="market_quality"]')).toBeVisible({ timeout: 15000 });
  await page.locator('.report-list-card[data-key="market_quality"]').click();
  const repRow = page.locator(".mkt-list .mkt-row", { hasText: `MqRep${stamp}` });
  await expect(repRow).toBeVisible({ timeout: 15000 });
  await expect(repRow.locator(".mkt-score")).toHaveText("60"); // shelf 1/1 = 60; the one price entry is flagged, so its 40 points are lost
  const flag = page.locator(".mkt-flag-row", { hasText: `MqShop${stamp}` });
  await expect(flag).toContainText("Մանր. < մեծ.");
  await expect(flag).toContainText("5,500/լ");
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-quality-390.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-quality-320.png`, fullPage: true });
  await page.locator("#mkt-info").click();
  await expect(page.locator(".mkt-info li")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await flag.click();
  await expect(page).toHaveURL(new RegExp(`#/customers/${shop.id}`));
});
