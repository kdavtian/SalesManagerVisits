import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: the Gold tier pays the Silver list; what makes Gold different is a special price on any product.
// The order's price-list comparison has no separate Gold row (it would equal Silver), and the special pricelist shows Silver only.
test("@smoke a Gold customer is priced from the Silver list until a special price is set", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const product = await fixtures.createProduct({ unit_price_amd: 10000 });
  await pool.query("UPDATE products SET bronze_price_amd = 10000, silver_price_amd = 9000, gold_price_amd = 8000, stock_qty = 50 WHERE id = $1", [product.id]);
  const customer = await fixtures.createCustomer({ name: "Gold Pays Silver", created_by: admin.id });
  await pool.query("UPDATE customers SET customer_tier = 'gold' WHERE id = $1", [customer.id]);

  await page.setViewportSize({ width: 440, height: 900 });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/orders/new/${customer.id}`);
  await page.locator(`[data-chip="${product.brand}"]`).click();
  const row = page.locator(`#order-product-list [data-product-id="${product.id}"]`);
  await expect(row).toContainText("9,000", { timeout: 10000 });
  await row.locator('[data-action="add"]').click();
  await page.locator("#oc-bar-info").click();
  const table = page.locator(".oc-tier-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3); // retail, bronze, silver · gold
  await expect(table.locator("tr.is-mine")).toContainText("Silver · Gold");
  await expect(table.locator("tr.is-mine")).toContainText("9,000");
  await page.screenshot({ path: "test-results/gold-pays-silver-order.png" });
  await page.keyboard.press("Escape");

  await page.goto(`/#/customers/${customer.id}/special-prices`);
  await page.locator(`[data-chip="${product.brand}"]`).click();
  const sp = page.locator(`.sp-row[data-product-id="${product.id}"]`);
  await expect(sp.locator(".sp-lists")).toHaveText(/Silver 9,000$/, { timeout: 10000 });
  await expect(sp.locator("[data-price]")).toHaveAttribute("placeholder", "9,000");
  await page.screenshot({ path: "test-results/gold-pays-silver-special.png" });
});
