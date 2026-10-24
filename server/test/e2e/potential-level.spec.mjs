import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: Potential Level -> Reason -> Save on the customer card; the counterfeit-products warning and its resolution by management.
test.use({ viewport: { width: 440, height: 956 } });
const SHOTS = process.env.PL_SHOTS;

test("rep sets the level and reasons in a few taps; counterfeit raises the warning; a director resolves it", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const director = await fixtures.createUser("sales_director");
  const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Potential Garage", sales_channel: "SM YVN" });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/customers/${c.id}`);
  await expect(page.locator(".pl-card")).toContainText("Not assessed", { timeout: 15000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pl-card-empty.png` });

  // Potential level -> Reason -> Save
  await page.locator("[data-pl-edit]").click();
  await page.locator('.pl-level-chip[data-level="4"]').click();
  await page.locator('.pl-reason-chip[data-reason="active_interest"]').click();
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pl-sheet.png` });
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(page.locator(".pl-card .pl-chip")).toContainText("High potential", { timeout: 10000 });
  await expect(page.locator(".pl-card")).toContainText("Active interest");
  // the header badge says how likely the sale is (instead of the plain tier name), and the Potential section sits between Products available and the visits
  await expect(page.locator(".detail-header-status-row .pl-badge")).toHaveText("Very likely");
  const order = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return [y("#product-chips-card"), y("#potential-slot .pl-card"), y("#visit-history-anchor")];
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);

  // nothing chosen -> a clear message, nothing saved
  await page.locator("[data-pl-edit]").click();
  await page.locator('.pl-reason-chip[data-reason="active_interest"]').click();
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(page.locator("#pl-error")).toBeVisible();
  // counterfeit: the warning shows inside the sheet at once, and on the card after saving; "Other" needs a text
  await page.locator('.pl-level-chip[data-level="1"]').click();
  await page.locator('.pl-reason-chip[data-reason="counterfeit"]').click();
  await expect(page.locator(".pl-sheet .pl-warn-banner")).toBeVisible();
  await page.locator('.pl-reason-chip[data-reason="other"]').click();
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(page.locator("#pl-error")).toBeVisible();
  await page.locator(".pl-other").fill("sells fakes next door");
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(page.locator(".pl-card .pl-warn-banner")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".pl-card .pl-chip")).toContainText("No potential");
  await expect(page.locator("[data-pl-resolve]")).toHaveCount(0); // the rep cannot lift it
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pl-card-counterfeit.png`, fullPage: true });

  // history
  await page.locator("[data-pl-history]").click();
  await expect(page.locator(".info-popup")).toContainText("No potential");
  await expect(page.locator(".info-popup")).toContainText("High potential");
  await page.locator('.info-popup [data-action="close"]').click();

  // the director resolves it
  await page.context().clearCookies();
  await loginViaUi(page, director.email);
  await page.goto(`/#/customers/${c.id}`);
  await page.locator("[data-pl-resolve]").click();
  await page.locator('#pl-resolve-form input[name="comment"]').fill("stopped selling fakes");
  await page.locator('#pl-resolve-form button[type="submit"]').click();
  await expect(page.locator(".pl-card .pl-warn-banner")).toHaveCount(0, { timeout: 10000 });
  const { rows: [r] } = await pool.query("SELECT counterfeit_flag, counterfeit_resolved_comment AS c, potential_level FROM customers WHERE id = $1", [c.id]);
  expect(r).toEqual({ counterfeit_flag: false, c: "stopped selling fakes", potential_level: 1 });
});

test("the reasons last used for a level are ticked again for the next customer (and never 'Other' / 'counterfeit')", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const first = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Remember One", sales_channel: "SM YVN" });
  const second = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Remember Two", sales_channel: "SM YVN" });
  await loginViaUi(page, rep.email);

  await page.goto(`/#/customers/${first.id}`);
  await page.locator("[data-pl-edit]").click();
  await expect(page.locator(".pl-prefill-note")).toBeHidden(); // nothing remembered yet
  await page.locator('.pl-level-chip[data-level="4"]').click();
  await page.locator('.pl-reason-chip[data-reason="negotiating"]').click();
  await page.locator('.pl-reason-chip[data-reason="other"]').click();
  await page.locator(".pl-other").fill("a typed explanation");
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(page.locator(".pl-card .pl-chip")).toContainText("High potential", { timeout: 10000 });

  await page.goto(`/#/customers/${second.id}`);
  await page.locator("[data-pl-edit]").click();
  await page.locator('.pl-level-chip[data-level="4"]').click();
  await expect(page.locator('.pl-reason-chip[data-reason="negotiating"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.pl-reason-chip[data-reason="other"]')).toHaveAttribute("aria-pressed", "false"); // "Other" needs its own text
  await expect(page.locator(".pl-prefill-note")).toBeVisible();
  // another level starts clean, and coming back to level 4 brings the ticks back
  await page.locator('.pl-level-chip[data-level="1"]').click();
  await expect(page.locator('.pl-reason-chip[aria-pressed="true"]')).toHaveCount(0);
  await page.locator('.pl-level-chip[data-level="4"]').click();
  await expect(page.locator('.pl-reason-chip[data-reason="negotiating"]')).toHaveAttribute("aria-pressed", "true");
  // touching a reason removes the "last used" label
  await page.locator('.pl-reason-chip[data-reason="active_interest"]').click();
  await expect(page.locator(".pl-prefill-note")).toBeHidden();
});
