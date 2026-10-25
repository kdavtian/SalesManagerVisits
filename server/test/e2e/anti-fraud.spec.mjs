import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: Vaghinak's Anti-fraud tab -- risk by rep, open findings with a verdict, the weekly check calls, the limits.
test("Anti-fraud tab: a payment missing from the Excel shows up, can be judged, and the limits can be changed", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Fraud Rep" });
  const erpId = `E2E-FR-${Date.now()}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: "E2E Fraud Customer", erp_customer_id: erpId });
  const paymentId = (
    await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, $2, $3, 480000, now() - interval '6 days', $4, 'E2E Fraud Rep', 'approved', $4, $4) RETURNING id`,
      [customer.id, customer.name, erpId, rep.id]
    )
  ).rows[0].id;
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/vaghinak?tab=antifraud");
    await expect(page.locator(".health-title", { hasText: "Risk by rep" })).toBeVisible({ timeout: 20000 });
    await page.locator("#fraud-run").click();
    const card = page.locator(".card[data-alert]", { hasText: "still not in the Excel" });
    // recorded 6 days after the collection is a finding of its own
    await expect(page.locator(".card[data-alert]", { hasText: "days after the collection" })).toBeVisible({ timeout: 15000 });
    await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card).toContainText("480,000");
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/fraud-tab.png`, fullPage: true });
    // the rep has a risk line
    await expect(page.locator(".health-row", { hasText: "E2E Fraud Rep" })).toBeVisible();
    // a verdict removes it from the open list
    await card.locator('[data-verdict="false_alarm"]').click();
    await expect(page.locator(".card[data-alert]", { hasText: "still not in the Excel" })).toHaveCount(0, { timeout: 10000 });
    // the limits are editable by an admin
    await page.locator('#fraud-settings input[name="custodyDays"]').fill("4");
    await page.locator('#fraud-settings button[type="submit"]').click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  } finally {
    await pool.query("DELETE FROM fraud_alerts WHERE rep_id = $1 OR customer_id = $2", [rep.id, customer.id]);
    await pool.query("DELETE FROM fraud_signal_weights");
    await pool.query("DELETE FROM fraud_settings");
    await pool.query("DELETE FROM fraud_spot_checks WHERE rep_id = $1", [rep.id]);
    await pool.query("DELETE FROM payments WHERE id = $1", [paymentId]);
  }
});

test("a sales rep does not see the Anti-fraud tab", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await page.goto("/#/vaghinak?tab=antifraud");
  await expect(page.locator("#vg-body")).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-tab="antifraud"]')).toHaveCount(0);
});
