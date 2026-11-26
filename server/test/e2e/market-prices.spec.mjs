import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Reports > Competitor prices (owner, 2026-11-26): per line and volume, our Castrol product beside each brand's median per litre, gaps.
test("competitor prices: our product and a brand's medians per litre, Armenian at 390 and 320 px", async ({ page, fixtures }) => {
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager");
  const admin = await fixtures.createUser("admin");
  const product = await fixtures.createProduct({ name: `Castrol GTX 15W-40 E2E${stamp}`, unit: "4L" });
  await pool.query("UPDATE products SET brand = 'Castrol', size_l = 4, bronze_price_amd = 12000, silver_price_amd = 11600, gold_price_amd = 11200, retail_price_amd = 15000 WHERE id = $1", [product.id]);
  for (const [w, r] of [[10000, 13000], [10400, 13400]]) {
    const shop = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
    const { rows: [ch] } = await pool.query(
      "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.51, 5, true) RETURNING id",
      [shop.id, rep.id]
    );
    await pool.query(
      `INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd)
       VALUES ($1, $2, $3, 'zic', 'pcmo_15w40', 4, 'L', $4, $5)`,
      [ch.id, shop.id, rep.id, w, r]
    );
  }

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/reports?r=market_prices");
  const group = page.locator(".mkt-group", { has: page.locator(".mkt-ours", { hasText: `E2E${stamp}` }) });
  await expect(group).toBeVisible({ timeout: 15000 });
  await expect(group.locator("h3")).toContainText("15W-40 · 4 լ");
  // Bronze 12,000 / 4 L = 3,000 a litre; retail 15,000 / 4 = 3,750
  await expect(group.locator(".mkt-ours", { hasText: `E2E${stamp}` })).toContainText("Բր 3,000");
  const zic = group.locator(".mkt-brand", { hasText: "Zic" });
  // Zic median wholesale 10,200 -> 2,550 a litre; retail 13,200 -> 3,300
  await expect(zic).toContainText("2,550");
  await expect(zic).toContainText("3,300");
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-prices-390.png` });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-prices-320.png` });
  await page.locator("#mkt-info").click();
  await expect(page.locator(".mkt-info li")).toHaveCount(5);
});
