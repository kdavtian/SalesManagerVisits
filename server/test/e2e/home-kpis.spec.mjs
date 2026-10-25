import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: the desktop Home shows the company's numbers instead of repeating the menu tiles; the phone keeps the tiles.
test("desktop Home: KPI tiles for the admin, no menu tiles; phone Home keeps the tiles", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const erp = `E2E-KPI-${Date.now()}`;
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, 'KPI1', current_date, 123000)", [erp]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/dashboard");
    const kpis = page.locator("#home-kpis");
    await expect(kpis.locator(".home-kpi")).toHaveCount(5, { timeout: 20000 });
    await expect(kpis.locator(".home-kpi", { hasText: "Sales this month" })).toContainText("AMD");
    await expect(kpis.locator(".home-kpi", { hasText: "Customers owe" })).toBeVisible();
    await expect(page.locator(".quick-actions-grid")).toBeHidden();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/home-kpis-desktop.png` });
    // a tile opens the page where it is dealt with
    await kpis.locator(".home-kpi", { hasText: "Customers owe" }).click();
    await expect(page).toHaveURL(/#\/debt-balances/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/dashboard");
    await expect(page.locator(".quick-actions-grid")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#home-kpis")).toBeHidden();
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erp]);
  }
});
