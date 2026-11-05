import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-05: the stock count problem. Management taps "!" next to the app's number and sees where it comes from.
test("Stock count: the ! shows Excel stock, packed out, delivered not in Excel yet and returns", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const { rows: [p] } = await pool.query("INSERT INTO products (name, brand, unit, unit_price_amd, active, stock_qty, synced_at) VALUES ('E2E Why Oil', 'Castrol', '4 L', 1000, true, 50, now()) RETURNING id");
  try {
    const customer = await fixtures.createCustomer({ created_by: admin.id });
    const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd) VALUES ($1, $2, 'packed_stock_out', 7000) RETURNING id", [customer.id, admin.id]);
    await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'E2E Why Oil', 1000, 7, 7000)", [o.id, p.id]);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    // the product is due today (the month's plan is made by the server; here the row is put in directly)
    await pool.query("INSERT INTO stock_counts (month, product_id, planned_date) VALUES (date_trunc('month', (now() AT TIME ZONE 'Asia/Yerevan')::date)::date, $1, (now() AT TIME ZONE 'Asia/Yerevan')::date) ON CONFLICT (month, product_id) DO UPDATE SET planned_date = EXCLUDED.planned_date, counted_at = NULL", [p.id]);
    await page.goto("/#/stock-count");
    const row = page.locator(".sc-row", { hasText: "E2E Why Oil" });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator(".sc-why").click();
    const popup = page.locator(".info-popup");
    await expect(popup).toContainText("50");
    await expect(popup).toContainText("−7");
    await expect(popup).toContainText("43");
    await page.waitForTimeout(600);
    await page.screenshot({ path: "/tmp/stock-why.png" });
  } finally {
    await pool.query("DELETE FROM stock_counts WHERE product_id = $1", [p.id]);
    await pool.query("DELETE FROM order_items WHERE product_id = $1", [p.id]);
    await pool.query("DELETE FROM products WHERE id = $1", [p.id]);
  }
});
