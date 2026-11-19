import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner plan P4 (2026-11-20): Warehouse > To order > "Create a purchase" -- one button per supplier (each product's last supplier), the
// form filled with the pieces to buy and the last price.
test("@smoke Warehouse To order: a purchase is created from the suggestions, by supplier, with the last price", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const acc = await fixtures.createUser("accountant");
  const stamp = Date.now();
  const product = await fixtures.createProduct({ name: `RO Edge ${stamp}`, brand: "Castrol", unit: "4L" });
  const erpId = `RO-E2E-${stamp}`;
  await pool.query("UPDATE products SET erp_product_id = $2, stock_qty = 0 WHERE id = $1", [product.id, erpId]);
  await pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) SELECT 'RO-E2E', $1 || '-' || g, CURRENT_DATE - (g * 7), $2, 15, 15000 FROM generate_series(0, 12) g",
    [`RO-E2E-${stamp}`, erpId]
  );
  await pool.query("INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, product_name, size_l, qty, cost_usd, excel_row) VALUES ('RO/1', CURRENT_DATE - 30, 'RO Supplier', $1, 'Edge', 4, 10, 17.25, 1)", [erpId]);
  try {
    await loginViaUi(page, acc.email);
    await page.goto("/#/warehouse");
    await page.locator('[data-tab="reorder"]').click();
    const btn = page.locator("[data-reorder-supplier]", { hasText: "RO Supplier" });
    await expect(btn).toBeVisible({ timeout: 15000 });
    await btn.click();
    const form = page.locator(".pu-form-sheet");
    await expect(form.locator(".pu-chip-on")).toContainText("RO Supplier");
    const line = form.locator(".pu-fl", { hasText: `RO Edge ${stamp}` });
    await expect(line).toHaveCount(1);
    expect(Number(await line.locator('[data-f="qty"]').inputValue())).toBeGreaterThan(0);
    await expect(line.locator('[data-f="cost_usd"]')).toHaveValue("17.25");
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/reorder-purchase.png" });
  } finally {
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fv_pu_draft")).forEach((k) => localStorage.removeItem(k))).catch(() => {});
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = 'RO-E2E'");
    await pool.query("DELETE FROM erp_purchase_lines WHERE supplier = 'RO Supplier'");
  }
});
