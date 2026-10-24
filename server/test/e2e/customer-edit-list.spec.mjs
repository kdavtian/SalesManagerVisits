import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-24: "when a user changes the name of a customer and goes back to the customers list, the name is not updated".
test("a customer renamed on its card shows the new name on the Customers list after Back", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Old Name Garage", sales_channel: "SM YVN" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/customers");
  const row = page.locator(`.list-row[data-id="${c.id}"]`);
  await expect(row).toContainText("E2E Old Name Garage", { timeout: 15000 });
  await row.click();
  await expect(page.locator("#edit-customer-btn")).toBeVisible({ timeout: 15000 });
  await page.locator("#edit-customer-btn").click();
  await page.locator('#edit-customer-form input[name="name"]').fill("E2E New Name Garage");
  await page.locator("#submit-edit-customer").click();
  await expect(page.locator(".detail-header, .customer-detail-view").first()).toContainText("E2E New Name Garage", { timeout: 15000 });
  await page.goBack();
  await expect(page.locator(`.list-row[data-id="${c.id}"]`)).toContainText("E2E New Name Garage", { timeout: 10000 });
  await expect(page.locator(`.list-row[data-id="${c.id}"]`)).not.toContainText("Old Name");
});
