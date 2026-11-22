import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-22: tapping a product on the Warehouse stock list opens its product card. A product stocked in several sizes opens the
// size whose pill was tapped; Back returns to the stock list exactly as it was (the search still typed).
test("@iphone warehouse stock: tapping a product or a size pill opens its product card, Back keeps the search", async ({ page, fixtures }) => {
  const wm = await fixtures.createUser("warehouse_manager");
  const tag = `WPC${Date.now().toString(36)}`;
  const single = await fixtures.createProduct({ name: `${tag} Oil Filter` });
  const oneL = await fixtures.createProduct({ name: `${tag} Edge 5W-30` });
  const fourL = await fixtures.createProduct({ name: `${tag} Edge 5W-30` });
  await pool.query("UPDATE products SET stock_qty = 7, brand = 'Castrol', unit = 'pcs' WHERE id = $1", [single.id]);
  await pool.query("UPDATE products SET stock_qty = 5, brand = 'Castrol', unit = '1 L' WHERE id = $1", [oneL.id]);
  await pool.query("UPDATE products SET stock_qty = 3, brand = 'Castrol', unit = '4 L' WHERE id = $1", [fourL.id]);

  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, wm.email);
  await page.goto("/#/warehouse");
  await page.locator("#inventory-search").fill(tag); // a search opens every group

  // single-size product: the whole card opens it
  await page.locator(`.inventory-row-card[data-open-product="${single.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/product/${single.id}$`));
  await expect(page.locator(".detail-view h1")).toBeVisible();
  await page.locator("#back-btn").first().click();
  await expect(page).toHaveURL(/#\/warehouse/);
  await expect(page.locator("#inventory-search")).toHaveValue(tag);

  // multi-size product: the 4 L pill opens the 4 L product, not the 1 L one
  await page.locator(`.inventory-variant-pill[data-open-product="${fourL.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/product/${fourL.id}$`));
  await page.locator("#back-btn").first().click();
  await expect(page).toHaveURL(/#\/warehouse/);

  // keyboard: Enter on a focused size pill opens it too
  await page.locator(`.inventory-variant-pill[data-open-product="${oneL.id}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/product/${oneL.id}$`));
});
