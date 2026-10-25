import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: Vaghinak's Expenses tab (numbers, findings, recommendations) and the "In Excel / Not in Excel" mark on the reps' own cash expenses.
test("Expenses tab shows the month bars, the categories and a field cash expense that the Excel does not have", async ({ page, fixtures, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Cash Rep" });
  const cat = `E2E Cat ${Date.now()}`;
  const categoryId = (await pool.query("INSERT INTO cash_categories (name, kind, sort_order) VALUES ($1, 'expense', 999) RETURNING id", [cat])).rows[0].id;
  const entryId = (
    await pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, info, origin) VALUES (current_date - 1, -250000, -250000, $1, 'e2e', 'manual') RETURNING id", [categoryId])
  ).rows[0].id;
  const expenseId = (await pool.query("INSERT INTO cash_expenses (user_id, amount_amd, purpose, created_at) VALUES ($1, 31000, 'E2E fuel', now() - interval '8 days') RETURNING id", [rep.id])).rows[0].id;
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/vaghinak?tab=expenses");
    await expect(page.locator(".health-title", { hasText: "Spending" })).toBeVisible({ timeout: 20000 });
    await page.locator("#exp-run").click();
    await expect(page.locator(".exp-bar")).toHaveCount(7);
    await expect(page.locator(".health-row", { hasText: cat })).toBeVisible({ timeout: 15000 });
    const repRow = page.locator(".health-row", { hasText: "E2E Cash Rep" });
    await expect(repRow).toBeVisible();
    await expect(repRow).toContainText("1 not in Excel");
    await expect(page.locator(".card[data-exp-alert]", { hasText: "E2E fuel" })).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/expenses-tab.png`, fullPage: true });
    // a finding can be dismissed
    await page.locator(".card[data-exp-alert]", { hasText: "E2E fuel" }).locator("[data-exp-dismiss]").click();
    await expect(page.locator(".card[data-exp-alert]", { hasText: "E2E fuel" })).toHaveCount(0, { timeout: 10000 });

    // the rep's own list says the same
    const { context, page: repPage } = await newIdentityPage(browser);
    try {
      await repPage.setViewportSize({ width: 390, height: 844 });
      await loginViaUi(repPage, rep.email);
      await repPage.goto("/#/expenses");
      const card = repPage.locator(".expense-card", { hasText: "E2E fuel" });
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(card.locator(".badge-warning")).toContainText("Not in Excel");
    } finally {
      await context.close();
    }
  } finally {
    await pool.query("DELETE FROM expense_alerts");
    await pool.query("DELETE FROM cash_expenses WHERE id = $1", [expenseId]);
    await pool.query("DELETE FROM cash_entries WHERE id = $1", [entryId]);
    await pool.query("DELETE FROM cash_categories WHERE id = $1", [categoryId]);
  }
});

test("a sales rep does not see the Expenses tab", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await page.goto("/#/vaghinak?tab=expenses");
  await expect(page.locator("#vg-body")).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-tab="expenses"]')).toHaveCount(0);
});
