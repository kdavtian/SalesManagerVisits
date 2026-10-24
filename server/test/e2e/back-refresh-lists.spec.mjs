import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24 (idea 1): a list restored by Back refreshes itself (Orders and Customers already did; now Activity, Debt balances and Tasks).
test("Activity: a visit saved while the person was on a customer card shows on the list after Back", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const a = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Back Alpha Shop", sales_channel: "SM YVN", lat: 40.18, lng: 44.5 });
  const b = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Back Bravo Shop", sales_channel: "SM YVN", lat: 40.19, lng: 44.51 });
  await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.5, 3, true)", [a.id, admin.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/activity");
  const first = page.getByText("E2E Back Alpha Shop").first();
  await expect(first).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("E2E Back Bravo Shop")).toHaveCount(0);
  await first.click();
  await expect(page.locator("#edit-customer-btn")).toBeVisible({ timeout: 15000 });
  await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.19, 44.51, 3, true)", [b.id, admin.id]);
  await page.goBack();
  await expect(page.getByText("E2E Back Bravo Shop").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("E2E Back Alpha Shop").first()).toBeVisible();
});
