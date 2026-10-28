import { test, expect, loginViaUi } from "./fixtures.mjs";

// The Home tile badges live in badges.js since 1.457.0 (moved out of app.js, docs/architecture-roadmap.md step 2): a waiting payment shows
// its count on the Payments tile, and after a reload the last known count is painted at once from the device, before the network answers.
test("@smoke Home: the Payments tile shows the waiting count, also straight after a reload", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const accountant = await fixtures.createUser("accountant");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: accountant.id });

  await loginViaUi(page, accountant.email);
  await page.goto("/#/dashboard");
  const badge = page.locator("#qa-payments-badge");
  await expect(badge).toBeVisible({ timeout: 15000 });
  await expect(badge).toHaveText(/^[1-9]\d*\+?$/);

  // the next start paints the remembered count before any badge request has answered
  await page.route("**/api/**/pending-count*", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.route("**/api/badges*", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect(page.locator("#qa-payments-badge")).toBeVisible({ timeout: 3000 });
});
