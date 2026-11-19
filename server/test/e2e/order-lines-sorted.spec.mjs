import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-19 (a customer card's order sheet): "Improve. Total pcs. Sort products." Brands in the price-list order, each brand's
// products in the catalogue order, the pieces of every brand and a total line with all pieces and the amount. Made-up products.
test("an order's lines: brands and products sorted, pieces per brand and in total", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const erpId = `E2E-OL-${Date.now()}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1,'x',0,0,now())", [erpId]);
  // given out of order on purpose
  const lines = [
    ["Royal", "0w20", "5", 1, 17000],
    ["Castrol", "Magnatec 10w40", "4", 2, 13000],
    ["Lotos", "5w30", "5", 1, 15000],
    ["Castrol", "Edge 5w40", "1", 2, 5000],
    ["Castrol", "Edge 0w20 C5", "4", 1, 23000],
    ["Castrol", "Edge 0w20 C5", "1", 3, 6000],
    ["Royal", "0w16", "1", 3, 4000],
  ];
  for (const [brand, name, size, qty, price] of lines) {
    await pool.query(
      "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, brand, product_name, size_l, qty, unit_price_amd, revenue_amd) VALUES ($1,'E2E-OL1', current_date - 1, $2, $3, $4, $5, $6, $7)",
      [erpId, brand, name, size, qty, price, qty * price]
    );
  }
  try {
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await page.locator('[data-stat="last-order"]').click();
    const sheet = page.locator(".sheet").last();
    await expect(sheet.locator(".erp-brand-group")).toHaveCount(3);
    expect(await sheet.locator(".erp-brand-head .proposed-changes-label").allTextContents()).toEqual(["Castrol", "Lotos", "Royal"]);
    const names = await sheet.locator(".erp-brand-group .erp-line-row > span:first-child").allTextContents();
    expect(names.map((s) => s.trim())).toEqual(["Edge 0w20 C5 1L", "Edge 0w20 C5 4L", "Edge 5w40 1L", "Magnatec 10w40 4L", "5w30 5L", "0w16 1L", "0w20 5L"]);
    const brandQty = (await sheet.locator(".erp-brand-qty").allTextContents()).map((s) => s.replace(/\D/g, ""));
    expect(brandQty).toEqual(["8", "1", "4"]);
    const total = sheet.locator(".erp-line-total");
    await expect(total).toContainText("13");
    await page.waitForTimeout(700);
    await page.screenshot({ path: process.env.ORDER_LINES_SHOT || "test-results/order-lines.png" });
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  }
});
