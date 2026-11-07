import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: Purchases beside the Excel Purchase_IN. An invoice only in the Excel is copied into the app in one tap and then matches.
test("@smoke Purchases: an Excel-only invoice is entered in the app from its own lines and then matches the Excel", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const product = await fixtures.createProduct({ unit: "4L" });
  const erpId = `PU-E2E-${Date.now()}`;
  await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [product.id, erpId]);
  const today = new Date().toISOString().slice(0, 10);
  const invoiceNo = `E2E ${Date.now() % 100000}/26`;
  await pool.query(
    "INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, product_name, size_l, qty, cost_usd, amount_amd, excel_row) VALUES ($1, $2, 'E2E Supplier', $3, 'Edge', 4, 120, 15.5, 716100, 1)",
    [invoiceNo, today, erpId]
  );
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, acc.email);
    await page.goto("/#/purchases");
    const row = page.locator(".pu-row", { hasText: "E2E Supplier" });
    await expect(row).toContainText("Only in Excel", { timeout: 15000 });
    await page.screenshot({ path: "test-results/purchases-phone.png" });
    await row.click();
    await page.locator("#pu-copy").click();
    const form = page.locator(".pu-form-sheet");
    await expect(form.locator('[name="invoice_no"]')).toHaveValue(invoiceNo);
    await expect(form.locator(".pu-form-line")).toHaveCount(1);
    await form.locator('[name="usd_rate"]').fill("385");
    await page.waitForTimeout(400); // the sheet has finished sliding in
    await page.screenshot({ path: "test-results/purchases-form.png" });
    await form.locator("#pu-save").click();
    await expect(page.locator(".pu-row", { hasText: "E2E Supplier" })).toContainText("Matches Excel", { timeout: 10000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "test-results/purchases-desktop.png" });
  } finally {
    await pool.query("DELETE FROM erp_purchase_lines WHERE erp_product_id = $1", [erpId]);
    await pool.query("DELETE FROM purchase_invoices WHERE invoice_no = $1", [invoiceNo]);
  }
});
