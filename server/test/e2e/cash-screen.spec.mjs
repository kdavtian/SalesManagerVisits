import { test, expect, loginViaUi, newIdentityPage } from "./fixtures.mjs";
import { pool } from "../../src/db/pool.js";

// The one Cash screen (owner, 2026-11-23): "Your turn" + "Where is the cash now" on the Money page, for each role, in Armenian.
test("cash screen: the rep sees his cash and hands it over; the director sees what to count; admin sees where the cash is and opens a place", async ({ page, browser, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager", { name: "Արտակ Հակոբյան" });
  const director = await fixtures.createUser("sales_director", { name: "Մարտին Սարգսյան" });
  const accountant = await fixtures.createUser("accountant", { name: "Մանե Պետրոսյան" });
  const admin = await fixtures.createUser("admin");
  const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Ավտոպահեստամասերի խանութ «Արարատ»" });
  const pay = (over) => fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, sales_manager_name_snapshot: rep.name, ...over });
  await pay({ amount_amd: 41000 });
  await pay({ amount_amd: 24000 });
  const handed = await pay({ amount_amd: 42000 });
  await pay({ amount_amd: 43000, current_holder_id: director.id });
  const office = await pay({ amount_amd: 44000, current_holder_id: accountant.id, status: "approved" });
  await pool.query("UPDATE payments SET approved_by = $2, approved_at = now() WHERE id = $1", [office.id, accountant.id]);
  const { rows: [h] } = await pool.query("INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by) VALUES ($1, $2, 42000, 'pending', $1) RETURNING id", [rep.id, director.id]);
  fixtures.track("cash_handoffs", h.id);
  await pool.query("INSERT INTO cash_handoff_items (handoff_id, payment_id) VALUES ($1, $2)", [h.id, handed.id]);
  await pool.query("UPDATE payments SET pending_handoff_id = $1 WHERE id = $2", [h.id, handed.id]);

  const shots = process.env.GB_SHOTS ?? "/tmp";
  const hy = (p) => p.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  const noSideScroll = async (p, label) => expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true);

  // the rep: his cash with the person it goes to, what he handed over and is not counted yet; no company card
  await hy(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  await page.goto("/#/money");
  const turn = page.locator("#cash-turn");
  await expect(turn).toContainText("65,000", { timeout: 10000 });
  await expect(turn).toContainText("Մարտին");
  await expect(turn).toContainText("42,000");
  await expect(page.locator("#cash-now")).toHaveCount(0);
  await noSideScroll(page, "rep 390");
  await page.screenshot({ path: `${shots}/cash-screen-rep-390.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(200);
  await noSideScroll(page, "rep 320");
  await page.screenshot({ path: `${shots}/cash-screen-rep-320.png`, fullPage: true });
  // every row that goes somewhere is tall enough to tap
  for (const box of await turn.locator("button.cash-row").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  // "Hand over" opens the hand-over screen
  await page.setViewportSize({ width: 390, height: 844 });
  await turn.locator("button.cash-row", { hasText: "65,000" }).click();
  await expect(page).toHaveURL(/#\/cash-handoffs/);

  // the director: the hand-over to count is the first thing, and his own counted cash goes to the accountant
  const dir = await newIdentityPage(browser);
  await hy(dir.page);
  await dir.page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(dir.page, director.email);
  await dir.page.goto("/#/money");
  const dirTurn = dir.page.locator("#cash-turn");
  await expect(dirTurn.locator("button.cash-row").first()).toContainText("Արտակ", { timeout: 10000 });
  await expect(dirTurn).toContainText("43,000"); // his counted cash, with the accountant it goes to
  await expect(dir.page.locator("#cash-now")).toBeVisible();
  await dir.page.screenshot({ path: `${shots}/cash-screen-director-390.png`, fullPage: true });
  await dirTurn.locator("button.cash-row").first().click();
  await expect(dir.page.locator("#handoff-detail-overlay")).toBeVisible({ timeout: 10000 });
  await dir.context.close();

  // admin: where the cash is; a place opens the Payments list on exactly those payments
  const boss = await newIdentityPage(browser);
  await hy(boss.page);
  await boss.page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(boss.page, admin.email);
  await boss.page.goto("/#/money");
  const now = boss.page.locator("#cash-now");
  await expect(now).toContainText("Արտակ", { timeout: 10000 });
  await noSideScroll(boss.page, "admin 390");
  await boss.page.screenshot({ path: `${shots}/cash-screen-admin-390.png`, fullPage: true });
  await boss.page.setViewportSize({ width: 320, height: 640 });
  await boss.page.waitForTimeout(200);
  await noSideScroll(boss.page, "admin 320");
  await boss.page.screenshot({ path: `${shots}/cash-screen-admin-320.png`, fullPage: true });
  await boss.page.setViewportSize({ width: 1440, height: 900 });
  await boss.page.waitForTimeout(200);
  await boss.page.screenshot({ path: `${shots}/cash-screen-admin-desktop.png` });
  await boss.page.setViewportSize({ width: 390, height: 844 });
  await now.locator("button.cash-row").nth(2).click(); // counted, with the director
  await expect(boss.page).toHaveURL(/place=with_director/);
  await expect(boss.page.locator(".pay-row .cash-place-chip").first()).toHaveAttribute("data-cash-place", "with_director", { timeout: 10000 });
  expect(await boss.page.locator('.pay-row .cash-place-chip:not([data-cash-place="with_director"])').count()).toBe(0);
  await boss.context.close();
});
