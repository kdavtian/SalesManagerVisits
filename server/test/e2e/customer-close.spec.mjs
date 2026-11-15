import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-15: a customer whose payments block the delete is CLOSED instead: out of the lists and plans, the card says so, reopen undoes it.
test("admin closes a customer with a reason (no confirm dialog), the card shows Closed without New order, Reopen brings it back @smoke", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Close Kotayk" });
  await fixtures.createPayment({ customer_id: c.id, sales_manager_id: admin.id, amount_amd: 50000 });
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.accept()));
  await loginViaUi(page, admin.email);
  await page.goto(`/#/customers/${c.id}`);
  await expect(page.locator("#new-order-btn")).toBeVisible({ timeout: 15000 });

  // the refused delete now points at Close
  await page.locator("#edit-customer-btn").click();
  await page.locator("#delete-customer-btn").click();
  await expect(page.locator("#edit-customer-error")).toContainText("Փոխարենը փակեք");
  dialogs = 0;

  await page.locator("#close-customer-btn").click();
  await expect(page.locator("#close-customer-confirm")).toBeDisabled();
  await page.locator("#close-customer-reason").fill("Խանութը փակվել է");
  await expect(page.locator("#close-customer-confirm")).toBeEnabled();
  await expect(page.locator("#close-customer-confirm")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath("close-sheet-hy.png") });
  await page.locator("#close-customer-confirm").click();
  expect(dialogs).toBe(0);

  const banner = page.locator(".cd-closed-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText("Խանութը փակվել է");
  await expect(page.locator("#new-order-btn")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("closed-card-hy.png") });
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator("#reopen-customer-btn")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("closed-card-hy-320.png") });
  await page.setViewportSize({ width: 390, height: 844 });

  // out of the Customers list
  await page.goto("/#/customers");
  await expect(page.locator(".list-row, .empty-state").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`.list-row[data-id="${c.id}"]`)).toHaveCount(0);

  // reopen from the card
  await page.goto(`/#/customers/${c.id}`);
  await page.locator("#reopen-customer-btn").click();
  await expect(page.locator(".cd-closed-banner")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator("#new-order-btn")).toBeVisible();
});
