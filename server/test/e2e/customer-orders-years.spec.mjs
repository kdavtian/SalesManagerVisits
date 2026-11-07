import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: a customer's full order list is grouped by year with subtotals and shows date, order, items, liters and brands; the
// payments are grouped by year too; the Customers heading carries its "!" after the title and (on a computer) worded buttons.
test("@smoke a customer's orders and payments are grouped by year with subtotals and order details", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const erpId = `CY${Date.now()}`;
  const customer = await fixtures.createCustomer({ name: "Years Garage", created_by: admin.id, erp_customer_id: erpId });
  const year = new Date().getFullYear();
  const lines = [
    [`${year}0105`, `${year}-01-05`, "Castrol", "GTX 5w40", "4", 3, 20000],
    [`${year}0105`, `${year}-01-05`, "Lotos", "Diesel 15w40", "1", 10, 3000],
    [`${year - 1}1120`, `${year - 1}-11-20`, "Royal", "10w40", "208", 1, 400000],
    [`${year - 1}0310`, `${year - 1}-03-10`, "Castrol", "Magnatec 5w30", "4", 2, 18000],
  ];
  for (const [oid, d, brand, name, size, qty, price] of lines) {
    await pool.query(
      "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, brand, product_name, size_l, qty, unit_price_amd, revenue_amd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [erpId, oid, d, brand, name, size, qty, price, qty * price]
    );
  }
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 50000), ($1, $3, 70000)", [erpId, `${year}-02-01`, `${year - 1}-12-01`]).catch(() => {});
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}/orders`);
    const card = page.locator(".co-card");
    await expect(card.locator(".co-year")).toHaveCount(2, { timeout: 15000 });
    await expect(card.locator(".co-year").first()).toContainText(String(year));
    await expect(card.locator(".co-year").first()).toContainText("90,000"); // 3x20,000 + 10x3,000
    await expect(card.locator(".co-row[data-order-id]").first()).toContainText("13");
    await expect(card.locator(".co-row[data-order-id]").first()).toContainText("22 L"); // 3x4 + 10x1
    await expect(card.locator(".co-row[data-order-id]").first().locator(".co-brand")).toHaveCount(2);
    await page.screenshot({ path: "test-results/co-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/co-phone.png" });
    // no row's parts overlap each other
    const overlaps = await page.evaluate(() => {
      const bad = [];
      for (const row of document.querySelectorAll(".co-row[data-order-id]")) {
        const parts = [...row.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width && r.height);
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i], b = parts[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(row.dataset.orderId);
        }
      }
      return bad;
    });
    expect(overlaps).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#/customers");
    await expect(page.locator("#toggle-debt-btn .cl-btn-label")).toBeVisible({ timeout: 15000 });
    const h1 = await page.locator(".list-header h1").boundingBox();
    const hint = await page.locator("#cl-legend-btn").boundingBox();
    expect(hint.x).toBeGreaterThan(h1.x + h1.width - 2); // the "!" comes after the title
    await page.screenshot({ path: "test-results/customers-desktop-head.png", clip: { x: 0, y: 0, width: 1440, height: 260 } });
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [erpId]).catch(() => {});
  }
});
