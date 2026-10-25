import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: on a desktop window Payments and Sales are tables (like Debt balances); phones keep the cards.
test("desktop: Payments and Sales are tables with sortable headings; phone keeps the cards", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Table Rep" });
  const erpId = `E2E-TBL-${Date.now()}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: "E2E Table Customer", erp_customer_id: erpId });
  const pay = async (amount, days, status = "approved") =>
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, 'E2E Table Rep', $7, $6, $6) RETURNING id`,
      [customer.id, customer.name, erpId, amount, String(days), rep.id, status]
    )).rows[0].id;
  const p1 = await pay(41000, 1, "pending");
  const p2 = await pay(52000, 6);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd, qty, size_l) VALUES ($1, 'T1', current_date, 300000, 10, '4'), ($1, 'T2', current_date - 1, 900000, 30, '4')", [erpId]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, admin.email);

    await page.goto("/#/payments?status=all");
    await page.locator("#payment-search").fill("E2E Table Customer");
    await expect(page.locator(`.pay-desk-row[data-payment-id="${p1}"]`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".desk-thead-pay")).toBeVisible();
    await expect(page.locator(`.pay-desk-row[data-payment-id="${p1}"]`)).toContainText("E2E Table Rep");
    await expect(page.locator(`.pay-desk-row[data-payment-id="${p1}"] .payment-approve-btn`)).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/payments-table.png` });
    await page.locator(`.pay-desk-row[data-payment-id="${p2}"]`).click();
    await expect(page.locator(".sheet")).toContainText("52,000");
    await page.keyboard.press("Escape");

    await page.goto("/#/dashboard");
    await page.goto("/#/sales");
    await page.locator('[data-tab="sales"]').click();
    await page.locator("#sales-search").fill("E2E Table Customer");
    await expect(page.locator(".sales-desk-row")).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator(".desk-thead-sales")).toBeVisible();
    // newest first; a click on Amount puts the biggest first
    await expect(page.locator(".sales-desk-row").first()).toContainText("T1");
    await page.locator('.desk-thead-sales [data-sort-key="amount"]').click();
    await expect(page.locator(".sales-desk-row").first()).toContainText("T2");
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/sales-table.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/sales");
    await page.locator('[data-tab="sales"]').click();
    await page.locator("#sales-search").fill("E2E Table Customer");
    await expect(page.locator(".sales-order-card").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".sales-desk-row")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM payments WHERE id = ANY($1)", [[p1, p2]]);
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
  }
});
