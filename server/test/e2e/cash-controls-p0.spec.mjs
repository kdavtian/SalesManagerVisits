import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// Improvement plan Phase 0 (owner, 2026-11-28).
// 0.16: cash the director already counted -- the accountant's payment card offers no Reject (the reason stands there), the CEO's does.
// 0.15: a shortfall on the director's own line -- he gets no Paid in / Write off; the accountant who counted it gets Paid in, and the note
//       is required.
test("payments: counted cash has no Reject for the accountant (with the reason); the CEO has it", async ({ page, browser, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const director = await fixtures.createUser("sales_director");
  const accountant = await fixtures.createUser("accountant");
  const ceo = await fixtures.createUser("ceo");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  // the director counted it: it is in his hands now, still pending
  const p = await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: director.id, amount_amd: 52000 });
  const shots = process.env.GB_SHOTS ?? "/tmp";

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, accountant.email);
  await page.goto(`/#/payments/${p.id}`);
  const actions = page.locator("#payment-detail-actions");
  await expect(page.locator(".payment-approve-hint").last()).toBeVisible({ timeout: 10000 });
  await expect(actions.locator('[data-action="reject"]')).toHaveCount(0);
  await expect(actions.locator('[data-action="approve"]')).toHaveCount(0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/p0-counted-accountant-390.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/p0-counted-accountant-320.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const boss = await newIdentityPage(browser);
  await boss.page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(boss.page, ceo.email);
  await boss.page.goto(`/#/payments/${p.id}`);
  await expect(boss.page.locator('#payment-detail-actions [data-action="reject"]')).toBeVisible({ timeout: 10000 });
  await boss.context.close();
});

test("shortfalls: no buttons on your own; the counter gets Paid in and must write how", async ({ page, browser, fixtures }) => {
  const director = await fixtures.createUser("sales_director");
  const accountant = await fixtures.createUser("accountant");
  const { rows: [h] } = await pool.query(
    `INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by, confirmed_by, confirmed_at)
     VALUES ($1, $2, 40000, 'confirmed', $1, $2, now()) RETURNING id`,
    [director.id, accountant.id]
  );
  fixtures.trackRow("cash_handoffs", h.id);
  const { rows: [sf] } = await pool.query("INSERT INTO cash_shortfalls (handoff_id, user_id, amount_amd, note) VALUES ($1, $2, 10000, '10,000') RETURNING id", [h.id, director.id]);
  const shots = process.env.GB_SHOTS ?? "/tmp";

  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, director.email);
  await page.goto("/#/cash-handoffs");
  const own = page.locator(`.shortfall-card[data-id="${sf.id}"]`);
  await expect(own).toBeVisible({ timeout: 10000 });
  await expect(own.locator("[data-sf]")).toHaveCount(0);

  const acc = await newIdentityPage(browser);
  await acc.page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await acc.page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(acc.page, accountant.email);
  await acc.page.goto("/#/cash-handoffs");
  const card = acc.page.locator(`.shortfall-card[data-id="${sf.id}"]`);
  await expect(card.locator('[data-sf="paid"]')).toBeVisible({ timeout: 10000 });
  await expect(card.locator('[data-sf="written_off"]')).toHaveCount(0);
  await card.locator('[data-sf="paid"]').click();
  await card.locator("[data-sf-save]").click();
  await expect(card.locator(".form-error")).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await acc.page.screenshot({ path: `${shots}/p0-shortfall-note-390.png` });
  await acc.page.setViewportSize({ width: 320, height: 640 });
  await card.scrollIntoViewIfNeeded();
  await acc.page.screenshot({ path: `${shots}/p0-shortfall-note-320.png` });
  expect(await acc.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await card.locator(".shortfall-note").fill("brought the next morning");
  const [res] = await Promise.all([acc.page.waitForResponse((r) => r.url().includes(`/shortfalls/${sf.id}/close`)), card.locator("[data-sf-save]").click()]);
  expect(res.ok()).toBeTruthy();
  await acc.context.close();
});
