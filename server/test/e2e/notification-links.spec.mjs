import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: tapping a notification must land on its subject, not a generic list.
test.describe("Notification links", () => {
  test("an order notification opens that order; a plan review opens Settings at the plan list; a performance one opens its tab", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, erp_customer_id: `E2E-NL-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 20000, payment_method: "invoice", product, quantity: 2 });
    const add = (title, url) => pool.query("INSERT INTO notifications (user_id, type, title, body, url) VALUES ($1, 'order_placed', $2, 'body', $3)", [admin.id, title, url]);
    await add("Order link", `/#/orders?open=${order.id}`);
    await add("Plan link", "/#/settings?section=plan-approvals");
    await add("PerfNew", "/#/team-performance?tab=approvals");
    await add("PerfOld", "/#/team-performance/approvals");
    await add("Text only", null);

    await loginViaUi(page, admin.email);
    await page.goto("/#/notifications");
    await page.locator(".notification-card", { hasText: "Order link" }).click();
    await expect(page).toHaveURL(new RegExp(`#/orders\\?open=${order.id}`));
    await expect(page.locator(".order-detail-sheet")).toContainText(order.order_code, { timeout: 10000 });

    await page.goto("/#/notifications");
    await page.locator(".notification-card", { hasText: "Plan link" }).click();
    await expect(page).toHaveURL(/#\/settings\?section=plan-approvals/);
    await expect(page.locator("#settings-admin-tab")).toHaveAttribute("aria-selected", "true");

    for (const title of ["PerfNew", "PerfOld"]) {
      await page.goto("/#/notifications");
      await page.locator(".notification-card", { hasText: title }).click();
      await expect(page).toHaveURL(/#\/team-performance/);
      await expect(page.locator("#perf-tab-filter-btn")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#perf-tab-filter-btn")).toContainText(/Approv|Հաստատ/i);
    }

    await page.goto("/#/notifications");
    await page.locator(".notification-card", { hasText: "Text only" }).click();
    await expect(page.locator(".sheet-overlay .sheet")).toContainText("Text only");
  });
});
