import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Frozen credit (owner, 2026-11-03): the card shows the NET debt with the frozen amount as its own line; the accountant sets it next to the limit.
test("@iphone customer card: net debt with the frozen line; the frozen amount is set next to the credit limit", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const erp = `E2EFZ${Date.now().toString(36)}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, name: "E2E Frozen Customer", erp_customer_id: erp });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 100000, now())", [erp]);
  await pool.query("UPDATE customers SET frozen_credit_amd = 40000, credit_limit_amd = 200000 WHERE id = $1", [customer.id]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await expect(page.getByText("60,000 AMD").first()).toBeVisible();
    await expect(page.locator(".frozen-credit-line")).toContainText("40,000");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/frozen-card.png` });
  } finally {
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erp]);
  }
});
