import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// The product card's Market section (owner, 2026-11-26): out-of-stock alert, a competitor of the same line and volume, wishes.
test("product card: Market section in Armenian at 390 and 320 px", async ({ page, fixtures }) => {
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager");
  const shop = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const product = await fixtures.createProduct({ name: `Castrol EDGE 0W-20 PM${stamp}`, unit: "4L" });
  await pool.query("UPDATE products SET brand = 'Castrol', size_l = 4, stock_qty = 0, bronze_price_amd = 30000, retail_price_amd = 36000 WHERE id = $1", [product.id]);
  const { rows: [ch] } = await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.51, 5, true) RETURNING id", [shop.id, rep.id]);
  await pool.query("INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd) VALUES ($1, $2, $3, 'petronas', 'pcmo_0w20', 4, 'L', 27000, 33000)", [ch.id, shop.id, rep.id]);
  await pool.query("INSERT INTO product_wishes (customer_id, product_id, quantity) VALUES ($1, $2, 2)", [shop.id, product.id]);

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  const director = await fixtures.createUser("sales_director");
  await loginViaUi(page, director.email);
  await page.goto(`/#/product/${product.id}`);
  const card = page.locator(".pm-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".pm-alert")).toContainText("Պահեստում չկա");
  await expect(card.locator(".pm-comp", { hasText: "Petronas" })).toContainText("27,000");
  await expect(card).toContainText("1 հաճախորդ · 2 հատ");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/product-market-390.png` });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/product-market-320.png` });
  await card.locator("#pm-info").click();
  await expect(page.locator(".mkt-info li")).toHaveCount(4);
});
