import { test, expect, loginViaUi, newIdentityPage } from "./fixtures.mjs";

// One route for cash (owner, 2026-11-23): cash that was not handed over yet is approved by its hand-over. The accountant's Payments
// screen offers no Approve for it (the reason stands next to Reject), the CEO's does ("CEO can do all").
test("payments: the accountant gets no Approve for cash still with the rep, with the reason; the CEO does", async ({ page, browser, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const accountant = await fixtures.createUser("accountant");
  const ceo = await fixtures.createUser("ceo");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  const p = await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: rep.id, amount_amd: 47000 });
  const shots = process.env.GB_SHOTS ?? "/tmp";

  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, accountant.email);
  await page.goto("/#/payments");
  const row = page.locator(`[data-payment-id="${p.id}"]`).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator(".payment-approve-btn")).toHaveCount(0);
  await page.goto(`/#/payments/${p.id}`);
  const actions = page.locator("#payment-detail-actions");
  await expect(actions.locator('[data-action="reject"]')).toBeVisible({ timeout: 10000 });
  await expect(actions.locator('[data-action="approve"]')).toHaveCount(0);
  await expect(page.locator(".payment-approve-hint")).toBeVisible();
  await page.waitForTimeout(600); // the sheet's slide-in, for the picture
  await page.screenshot({ path: `${shots}/one-route-accountant-390.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/one-route-accountant-320.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const boss = await newIdentityPage(browser);
  await boss.page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(boss.page, ceo.email);
  await boss.page.goto(`/#/payments/${p.id}`);
  const bossActions = boss.page.locator("#payment-detail-actions");
  await expect(bossActions.locator('[data-action="approve"]')).toBeVisible({ timeout: 10000 });
  await boss.page.screenshot({ path: `${shots}/one-route-ceo-390.png` });
  // two taps, no pop-up: the first arms the button, the second approves
  await bossActions.locator('[data-action="approve"]').click();
  const [res] = await Promise.all([
    boss.page.waitForResponse((r) => r.url().includes(`/payments/${p.id}/approve`)),
    bossActions.locator('[data-action="approve"]').click(),
  ]);
  expect(res.ok()).toBeTruthy();
  await boss.context.close();
});
