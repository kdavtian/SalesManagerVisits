import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: a cash row is added as IN / OUT / Transfer -> category -> subcategory; the admin manages the tree.
test("@smoke Cashflow: OUT -> Running costs -> Fuel is saved; the admin opens the categories", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const { rows: [acc] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id, name", [`E2E Box ${Date.now() % 100000}`]);
  const note = `E2E fuel ${Date.now() % 100000}`;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/cashflow");
    await page.locator("#cf-add").click({ timeout: 15000 });
    const form = page.locator("#cf-form");
    await form.locator('#cf-dir3 [data-dir="out"]').click();
    await form.locator("#cf-group-chip").click();
    await page.locator(".cf-pick-sheet [data-value]", { hasText: "Running costs" }).click();
    // more than one subcategory: the subcategory list opens by itself
    await page.locator(".cf-pick-sheet [data-value]", { hasText: "Fuel" }).click();
    await expect(form.locator("#cf-cat-text")).toHaveText("Fuel");
    await form.locator("#cf-acc-chip").click();
    await page.locator(".cf-pick-sheet [data-value]", { hasText: acc.name }).click();
    await form.locator('[name="amount"]').fill("12000");
    await form.locator('[name="info"]').fill(note);
    await page.screenshot({ path: "test-results/cashflow-add.png" });
    await form.locator('button[type="submit"]').click();
    await expect.poll(async () => (await pool.query("SELECT amount::float8 AS a, c.name FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id WHERE e.info = $1", [note])).rows[0] ?? null, { timeout: 10000 }).toEqual({ a: -12000, name: "Fuel" });
    await page.locator("#cf-categories-btn").click();
    await expect(page.locator(".ccm-sheet")).toContainText("Running costs");
    await expect(page.locator(".ccm-sheet")).toContainText("Fuel");
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/cashflow-categories.png" });
  } finally {
    await pool.query("DELETE FROM cash_entries WHERE info = $1", [note]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [acc.id]);
  }
});
