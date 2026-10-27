import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-26: the customer card must open smoothly -- no ghost, no step-by-step loading.
test("@smoke the customer card opens whole (social icons included) and a second visit draws from the saved copy at once", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Instant Card Garage", sales_channel: "SM YVN" });
  await pool.query("UPDATE customers SET instagram_username = $1, email = $2 WHERE id = $3", ["e2e_instant", "e2e@example.com", c.id]);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/customers");
  const row = page.locator(`.list-row[data-id="${c.id}"]`);
  await expect(row).toContainText("E2E Instant Card Garage", { timeout: 15000 });

  // First visit: the icons are there in the same paint as the card's name (not added a request later).
  await row.click();
  await expect(page.locator("#customer-detail-name")).toContainText("E2E Instant Card Garage", { timeout: 15000 });
  await expect(page.locator(".customer-social-instagram")).toHaveCount(1, { timeout: 0 });
  await expect(page.locator(".customer-social-email")).toHaveCount(1, { timeout: 0 });
  // the action row (owner, 2026-10-27): Check in, New task, New order, Navigate, Files -- no Orders button; no empty tasks block
  const ids = await page.locator(".detail-actions-grid .action-btn").evaluateAll((els) => els.map((e) => e.id));
  expect(ids).toEqual(["checkin-btn", "new-task-btn", "new-order-btn", "navigate-btn", "customer-photos-btn"]);
  await expect(page.locator("#customer-tasks-slot .tasks-block")).toHaveCount(0);

  // Back, then open it again with the network held back: the saved copy must draw the whole card without waiting for the server.
  await page.goBack();
  await expect(row).toBeVisible();
  await page.route(/\/api\/customers\/\d+(\/|\?|$)/, () => {}); // never answered
  await page.route(/\/api\/customer-social\//, () => {});
  await page.evaluate((id) => (location.hash = `#/customers/${id}?again`), c.id);
  await expect(page.locator("#customer-detail-name")).toContainText("E2E Instant Card Garage", { timeout: 3000 });
  await expect(page.locator(".customer-social-instagram")).toHaveCount(1, { timeout: 0 });
  await expect(page.locator(".loading-state")).toHaveCount(0);
});
