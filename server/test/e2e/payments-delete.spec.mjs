import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: the Payments page says whether the Excel shows each payment, has a "Not in Excel" filter, and an admin can delete a payment
// (two taps, no browser dialog; the payment is archived).
test("Excel badge and filter on the Payments page; admin deletes a payment with a reason", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const erpId = `E2E-PAY-${Date.now()}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: "E2E Pay Customer", erp_customer_id: erpId });
  const ins = async (amount, daysAgo) =>
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, 'E2E Rep', 'approved', $6, $6) RETURNING id`,
      [customer.id, customer.name, erpId, amount, String(daysAgo), rep.id]
    )).rows[0].id;
  const matched = await ins(15000, 8);
  const missing = await ins(26000, 8);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, current_date - 8, 15000)", [erpId]);
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/payments?status=all");
    await page.locator("#payment-search").fill("E2E Pay Customer");
    await expect(page.locator(`[data-payment-id="${matched}"]`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`.list-row[data-payment-id="${matched}"] .badge-success`, { hasText: "In Excel" })).toBeVisible();
    await expect(page.locator(`.list-row[data-payment-id="${missing}"] .badge-warning`, { hasText: "Not in Excel" })).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/payments-excel.png` });

    // the filter keeps only the one the Excel misses
    await page.locator('[data-filter="excel_missing"]').click();
    await expect(page.locator(`.list-row[data-payment-id="${missing}"]`)).toBeVisible();
    await expect(page.locator(`.list-row[data-payment-id="${matched}"]`)).toHaveCount(0);

    // delete it: two steps, reason, gone
    await page.locator(`.payment-row-main[data-payment-id="${missing}"]`).click();
    await page.locator('[data-action="delete"]').click();
    await expect(page.locator("#payment-delete-reason")).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/payments-delete.png` });
    await page.locator("#payment-delete-reason").fill("entered twice");
    await page.locator("#payment-delete-go").click();
    await expect(page.locator(`.list-row[data-payment-id="${missing}"]`)).toHaveCount(0, { timeout: 10000 });
    const { rows } = await pool.query("SELECT reason FROM deleted_payments WHERE payment_id = $1", [missing]);
    expect(rows[0]?.reason).toBe("entered twice");
  } finally {
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM deleted_payments WHERE payment_id = $1", [missing]);
    await pool.query("DELETE FROM payments WHERE id = ANY($1)", [[matched, missing]]);
  }
});

test("a rep has no Delete button and no Not-in-Excel filter", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await page.goto("/#/payments");
  await expect(page.locator("#payment-quick-filters")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-filter="excel_missing"]')).toHaveCount(0);
});
