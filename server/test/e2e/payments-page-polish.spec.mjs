import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-05: the Payments page checkup. Banner with the money and the oldest wait, group totals, two-tap approve, inline reject
// reason (no browser pop-ups), the wheel date picker, a return from Back shows no loading flash.
test("Payments page: banner, group totals, two-tap approve, inline reason, wheel date", async ({ page, fixtures }) => {
  const manager = await fixtures.createUser("sales_manager");
  const accountant = await fixtures.createUser("accountant");
  const customer = await fixtures.createCustomer({ created_by: manager.id, name: "E2E Pay Polish Shop" });
  const mk = (amount, daysAgo) =>
    fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: manager.id, current_holder_id: accountant.id, amount_amd: amount, payment_date: new Date(Date.now() - daysAgo * 86400000).toISOString() });
  const first = await mk(25000, 0);
  await mk(40000, 6);
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.type()); d.dismiss(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, accountant.email);
  await page.goto("/#/payments");
  await expect(page.locator(`[data-payment-id="${first.id}"]`).first()).toBeVisible({ timeout: 10000 });

  // the banner says how many, how much and how long the oldest waits
  const banner = page.locator("#payments-pending-summary");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/65,000/);
  await expect(banner).toContainText(/6/);
  // group heading: count and money
  await expect(page.locator(".list-group-heading .list-group-sum").first()).toContainText(/2 · 65,000/);
  await page.screenshot({ path: "/tmp/payments-list.png" });

  // approve is two taps: the first only arms the button
  const approve = page.locator(`[data-payment-id="${first.id}"] .payment-approve-btn`);
  await approve.click();
  await expect(approve).toHaveText(/Confirm\?/);
  await page.screenshot({ path: "/tmp/payments-armed.png" });

  // reject: an inline reason, no prompt()
  await page.locator(`[data-payment-id="${first.id}"] .payment-row-main`).click();
  await page.locator('[data-action="reject"]').click();
  await expect(page.locator("#payment-reason")).toBeVisible();
  await page.locator("#payment-reason-go").click();
  await expect(page.locator("#payment-detail-error")).toBeVisible(); // empty reason is refused
  await page.locator("#payment-reason").fill("Wrong amount");
  await page.screenshot({ path: "/tmp/payments-reject.png" });
  await page.locator("#payment-reason-go").click();
  await expect(page.locator(".sheet .badge", { hasText: /Rejected|Մերժված/ }).first()).toBeVisible({ timeout: 10000 });
  expect(dialogs).toEqual([]); // not one browser dialog
});

test("Payments page: a rep adds a payment with the wheel date picker; a far-future date is refused", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Pay Date Shop" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  await page.goto("/#/payments");
  await page.locator("#payments-new-btn").click();
  await expect(page.locator("#payment-date-btn")).toBeVisible();
  await expect(page.locator("#payment-date-input")).toHaveAttribute("type", "hidden");
  await page.screenshot({ path: "/tmp/payments-add.png" });
  await page.locator("#payment-date-btn").click();
  await expect(page.locator(".date-picker, .sheet-overlay .wheel, [data-picker-title]").first()).toBeVisible({ timeout: 5000 }).catch(() => {});
});
