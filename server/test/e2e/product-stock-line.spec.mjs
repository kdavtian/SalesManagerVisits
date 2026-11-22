import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-22: the product card shows the free stock as "Edge • 4 L • 23 հատ"; a tap switches it to liters ("Edge • 4 L • 92 L"),
// a switch hides / shows the line, and both choices stay on the phone. Free = stock minus what open orders hold (available_qty).
test("@iphone product card: free stock line, pcs <-> liters on tap, show/hide switch remembered", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const oil = await fixtures.createProduct({ name: `E2E Stock Line ${Date.now().toString(36)}` });
  const filter = await fixtures.createProduct({ name: `E2E Stock Filter ${Date.now().toString(36)}` });
  const blank = await fixtures.createProduct({ name: `E2E Stock None ${Date.now().toString(36)}` });
  await pool.query("UPDATE products SET stock_qty = 23, brand = 'Castrol', family = 'Edge', unit = '4 L' WHERE id = $1", [oil.id]);
  await pool.query("UPDATE products SET stock_qty = 7, brand = 'Castrol', family = NULL, unit = 'pcs' WHERE id = $1", [filter.id]);
  await pool.query("UPDATE products SET stock_qty = NULL WHERE id = $1", [blank.id]);

  await page.setViewportSize({ width: 320, height: 760 });
  await loginViaUi(page, rep.email);
  await page.evaluate(() => {
    localStorage.removeItem("fv_pd_stock_on");
    localStorage.removeItem("fv_pd_stock_unit");
  });
  await page.goto(`/#/product/${oil.id}`);
  const line = page.locator("#pd-stock-line");
  await expect(line).toContainText("Edge • 4 L • 23 pcs");
  await line.click();
  await expect(line).toContainText("Edge • 4 L • 92 L");
  await expect(page.locator("#pd-stock-line")).toBeFocused(); // redrawn, focus kept

  // the liters choice is remembered on the next card
  await page.reload();
  await expect(page.locator("#pd-stock-line")).toContainText("92 L");

  // switch off: the line is gone, also after a reload; switch on: back
  const toggle = page.locator("#pd-stock-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(page.locator("#pd-stock-line")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#pd-stock-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#pd-stock-line")).toHaveCount(0);
  await page.locator("#pd-stock-toggle").click();
  await expect(page.locator("#pd-stock-line")).toContainText("92 L");

  // a workbook category as family ("Other") is not a product line: the name is used instead
  await pool.query("UPDATE products SET family = 'Other' WHERE id = $1", [oil.id]);
  await page.reload();
  await expect(page.locator("#pd-stock-line")).toContainText(`${oil.name} • 4 L • 92 L`);

  // a filter (no liters): pieces only, not a button
  await page.goto(`/#/product/${filter.id}`);
  await expect(page.locator(".pd-stock-line")).toHaveText(`${filter.name} • 7 pcs`);
  await expect(page.locator("#pd-stock-line")).toHaveCount(0);

  // no stock on record: no stock card at all
  await page.goto(`/#/product/${blank.id}`);
  await expect(page.locator(".detail-view h2")).toBeVisible();
  await expect(page.locator(".pd-stock-card")).toHaveCount(0);
});
