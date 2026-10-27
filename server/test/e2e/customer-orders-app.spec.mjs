import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-27: the customer's Orders page shows the orders placed in the app (drafts too) that Excel does not have yet, with their status.
test("an app order that Excel does not have yet is listed on the customer's Orders page and opens its details", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E App Orders Garage", sales_channel: "SM YVN" });
  const order = await fixtures.createOrder({ customer_id: c.id, user_id: admin.id, status: "draft", total_amd: 123000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/customers/${c.id}/orders`);
  const row = page.locator(`[data-app-order="${order.id}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText("123,000");
  await expect(row.locator(".badge")).toBeVisible();
  await row.click();
  await expect(page.locator(".sheet-overlay")).toBeVisible();
});
