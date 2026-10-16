import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-18: search on Debt balances; the customer card's "Order usual" strip must not wait for the catalog.
test.describe("Debt search and usual strip", () => {
  test("debt balances search narrows the list and the totals", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const row = (o) => ({
      internal_customer_id: 1, customer_id: "10123", customer_name: "10123 Shirak Garage", remaining_balance: 1200000, overdue_amd: 300000,
      oldest_due_days: 14, unrecorded_amd: 0, last_payment_date: "2026-10-01", last_visit_at: "2026-10-10T08:00:00Z",
      sales_channel: "SM YVN", assigned_manager_id: admin.id, assigned_manager_name: "Rep", ...o,
    });
    await page.route("**/api/debt-balances*", (route) =>
      route.fulfill({
        json: {
          rows: [row({}), row({ internal_customer_id: 2, customer_id: "10124", customer_name: "10124 Green Oil Point", remaining_balance: 500000, overdue_amd: 0, oldest_due_days: -7 })],
          as_of_date: null,
          sync: { last_synced_at: new Date().toISOString() },
        },
      })
    );
    await loginViaUi(page, admin.email);
    await page.goto("/#/debt-balances");
    await expect(page.locator(".debt-balance-card")).toHaveCount(2, { timeout: 10000 });
    await page.locator("#debt-search").fill("green");
    await expect(page.locator(".debt-balance-card")).toHaveCount(1);
    await expect(page.locator("#debt-total-amount")).toContainText("500,000");
    await page.locator("#debt-search").fill("10123 shirak");
    await expect(page.locator(".debt-balance-card")).toHaveCount(1);
    await expect(page.locator(".debt-balance-card")).toContainText("Shirak Garage");
    await page.locator("#debt-search").fill("nobody");
    await expect(page.locator(".debt-balance-card")).toHaveCount(0);
    await page.locator("#debt-search").fill("");
    await expect(page.locator(".debt-balance-card")).toHaveCount(2);
  });

  test("the Order usual strip appears before the product catalog has arrived", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const customer = await fixtures.createCustomer({ created_by: admin.id, name: "Usual Strip Customer" });
    await page.route("**/api/customers/*/reorder-profile*", (route) =>
      route.fulfill({ json: { cadence: { median_gap_days: 10, days_since_order: 5, state: "ok" }, orders_considered: 4, items: [{ product_id: 1, name: "X", quantity: 2 }], skipped: 0, lines: null } })
    );
    await page.route("**/api/products*", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await expect(page.locator("[data-usual-order]")).toBeVisible({ timeout: 2000 });
    await expect(page.locator("[data-usual-count]")).not.toContainText("~");
  });
});
