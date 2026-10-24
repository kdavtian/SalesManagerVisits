import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: filters for potential customers (level, reason, follow-up, counterfeit...), follow-up priority order, counts on the company dashboard.
test.use({ viewport: { width: 440, height: 956 } });
const SHOTS = process.env.PL_SHOTS;

test("customers list: potential filter + priority order; the company dashboard counts prospects per level and links to them", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const director = await fixtures.createUser("sales_director");
  const mk = async (name, level, reasons, extra = "") => {
    const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name, sales_channel: "SM YVN" });
    await pool.query(`UPDATE customers SET potential_level = $2, potential_reasons = $3 ${extra} WHERE id = $1`, [c.id, level, reasons]);
    return c;
  };
  await mk("E2E PF Low Shop", 2, ["small_volume"]);
  await mk("E2E PF High Garage", 4, ["ready_first_order"], ", next_followup_date = current_date");
  await mk("E2E PF Fake Seller", 1, ["counterfeit"], ", counterfeit_flag = true");
  await mk("E2E PF Unassessed", null, []);
  await mk("E2E PF Real Workshop", 3, ["active_interest"]);

  await loginViaUi(page, rep.email);
  await page.goto("/#/customers");
  await expect(page.locator(".list-row", { hasText: "E2E PF Low Shop" })).toBeVisible({ timeout: 15000 });
  // chips on the rows
  await expect(page.locator(".list-row", { hasText: "E2E PF High Garage" })).toContainText("High potential");
  await expect(page.locator(".list-row", { hasText: "E2E PF Fake Seller" })).toContainText("⚠️");

  // the filter sheet: level 4 + 3 -> the worklist, high first
  await page.locator('[data-filter-btn="potential"]').click();
  await page.locator('.pf-sheet [data-level="3"]').click();
  await page.locator('.pf-sheet [data-level="4"]').click();
  await expect(page.locator("#pf-done")).toContainText("Show 2");
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pf-sheet.png` });
  await page.locator("#pf-done").click();
  const rows = page.locator(".list-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("E2E PF High Garage");
  await expect(rows.nth(1)).toContainText("E2E PF Real Workshop");

  // counterfeit only
  await page.locator('[data-filter-btn="potential"]').click();
  await page.locator('.pf-sheet #pf-clear').click();
  await page.locator('.pf-sheet [data-counterfeit]').click();
  await page.locator("#pf-done").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("E2E PF Fake Seller");

  // follow-up due + the deep link from the dashboard
  await page.goto("/#/customers?potential=due");
  await expect(rows.filter({ hasText: "E2E PF High Garage" })).toHaveCount(1, { timeout: 10000 });
  await expect(rows.filter({ hasText: "E2E PF Low Shop" })).toHaveCount(0);

  // the director's company dashboard
  await page.context().clearCookies();
  await loginViaUi(page, director.email);
  await page.goto("/#/company-dashboard");
  const card = page.locator("#company-dashboard-prospects");
  await expect(card.locator('[data-potential="4"]')).toContainText("High potential", { timeout: 15000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pf-dashboard.png`, fullPage: true });
  expect(Number((await card.locator('[data-potential="4"] strong').innerText()).trim())).toBeGreaterThanOrEqual(1);
  await expect(card.locator('[data-potential="counterfeit"]')).toBeVisible();
  await card.locator('[data-potential="3"]').click();
  await expect(page.locator(".list-row", { hasText: "E2E PF Real Workshop" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".list-row", { hasText: "E2E PF Low Shop" })).toHaveCount(0);
});
