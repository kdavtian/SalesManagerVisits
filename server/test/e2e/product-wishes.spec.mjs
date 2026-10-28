import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// Wished products (owner, 2026-10-28): on the order screen an out-of-stock product offers "Wish" instead of Add, and a search offers
// "Product we don't have"; neither goes into the order. Management reads them in Reports > Wished products.
test("order screen: wish an out-of-stock product and a new one; the report lists both", async ({ page, browser, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager");
  const admin = await fixtures.createUser("admin");
  const shop = await fixtures.createCustomer({ name: `WishShop${stamp}`, created_by: rep.id, assigned_manager_id: rep.id });
  const product = await fixtures.createProduct({ name: `WishOil${stamp}`, unit: "4L" });
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [product.id]);

  await loginViaUi(page, rep.email);
  await page.goto(`/#/orders/new/${shop.id}`);
  await page.locator("#product-search").fill(`WishOil${stamp}`);
  const row = page.locator(`.order-product-row[data-product-id="${product.id}"]`);
  await row.locator('[data-action="wish"]').click();
  const sheet = page.locator(".wish-sheet");
  await expect(sheet).toContainText(`WishOil${stamp}`);
  await sheet.locator('input[name="quantity"]').fill("6");
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/wish-sheet.png` });
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).toBeHidden();
  await expect(row.locator(".oc-wished")).toBeVisible();
  await expect(page.locator("#order-cart-bar")).toBeHidden(); // nothing went into the order

  await page.locator("#product-search").fill(`NeverHad${stamp}`);
  await page.locator("[data-wish-new]").click();
  await expect(sheet.locator('input[name="custom_name"]')).toHaveValue(`NeverHad${stamp}`);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/wish-new.png` });
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).toBeHidden();

  const { rows } = await pool.query("SELECT id, product_id, custom_name, quantity FROM product_wishes WHERE customer_id = $1 ORDER BY id", [shop.id]);
  expect(rows.map((r) => [r.product_id, r.custom_name, r.quantity])).toEqual([
    [product.id, null, 6],
    [null, `NeverHad${stamp}`, 1],
  ]);

  // management: Reports > Wished products
  const { context, page: desk } = await newIdentityPage(browser);
  await desk.setViewportSize({ width: 1440, height: 900 });
  await loginViaUi(desk, admin.email);
  await desk.goto("/#/reports?r=product_wishes");
  const oilRow = desk.locator(".wish-report-row", { hasText: `WishOil${stamp}` });
  await expect(oilRow).toBeVisible({ timeout: 15000 });
  await expect(desk.locator(".wish-report-row", { hasText: `NeverHad${stamp}` })).toBeVisible();
  await oilRow.locator("summary").click();
  await expect(oilRow.locator(".wish-item")).toContainText(`WishShop${stamp}`);
  await desk.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/wish-report.png` });
  await context.close();
});
