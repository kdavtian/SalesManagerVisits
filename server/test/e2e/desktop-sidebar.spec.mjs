import { test, expect, loginViaUi } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 5: the desktop sidebar's MORE list is in groups (Sales / Money / Operations / Admin) that fold
// and stay folded; the "(new)" warehouse and driver apps are not in it (one Warehouse); the sidebar can be icons only (toggle,
// remembered; automatic on a 1024-1279 px window). Role shells keep their full sidebar.
test.describe("Desktop sidebar", () => {
  test("groups fold and stay folded; one Warehouse; the icons-only toggle is remembered", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator('[data-group="sales"]')).toBeVisible({ timeout: 15000 });
    for (const key of ["money", "operations", "admin"]) await expect(sidebar.locator(`[data-group="${key}"]`)).toBeVisible();
    await expect(sidebar.locator('[data-group="money"] [data-hash="#/cashflow"]')).toBeVisible();
    await expect(sidebar.locator('[data-group="operations"] [data-hash="#/warehouse"]')).toBeVisible();
    await expect(sidebar.locator('[data-hash="#/warehouse"]')).toHaveCount(1);
    await expect(sidebar.locator('[data-hash="#/wh-home"]')).toHaveCount(0);
    await expect(sidebar.locator('[data-hash="#/driver-home"]')).toHaveCount(0);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-sidebar.png` });

    // fold Money: its items go, the fold survives a reload; the page that is open still shows in a folded group
    await sidebar.locator('[data-group-toggle="money"]').click();
    await expect(sidebar.locator('[data-group-toggle="money"]')).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.locator('[data-hash="#/cashflow"]')).toBeHidden();
    await page.reload();
    await expect(sidebar.locator('[data-group-toggle="money"]')).toHaveAttribute("aria-expanded", "false", { timeout: 15000 });
    await page.goto("/#/cashflow");
    await expect(sidebar.locator('[data-group="money"] [data-hash="#/cashflow"]')).toHaveClass(/sidebar-item-active/, { timeout: 15000 });
    await expect(sidebar.locator('[data-group="money"] [data-hash="#/debt-balances"]')).toBeHidden();
    await sidebar.locator('[data-group-toggle="money"]').click();
    await expect(sidebar.locator('[data-hash="#/debt-balances"]')).toBeVisible();

    // icons only: the toggle narrows the sidebar, hides the words, and is remembered
    await sidebar.locator("#sidebar-toggle").click();
    await expect(page.locator("html")).toHaveClass(/sidebar-collapsed/);
    expect((await sidebar.boundingBox()).width).toBeLessThan(80);
    await expect(sidebar.locator('[data-hash="#/orders"] > span:not(.sidebar-item-icon)')).toBeHidden();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-sidebar-collapsed.png` });
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/sidebar-collapsed/, { timeout: 15000 });
    await sidebar.locator("#sidebar-toggle").click();
    await expect(page.locator("html")).not.toHaveClass(/sidebar-collapsed/);
    expect((await sidebar.boundingBox()).width).toBeGreaterThan(200);
  });

  test("a 1024-1279 px window starts icons only; a role shell keeps its full sidebar", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1200, height: 860 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await expect(page.locator(".sidebar [data-hash=\"#/orders\"]")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("html")).toHaveClass(/sidebar-collapsed/);
    // a wider window goes back to the full sidebar while the choice is still "automatic"
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("html")).not.toHaveClass(/sidebar-collapsed/);

    await page.context().clearCookies();
    const wh = await fixtures.createUser("warehouse_manager");
    await page.setViewportSize({ width: 1200, height: 860 });
    await loginViaUi(page, wh.email);
    await expect(page.locator(".sidebar [data-hash]").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#sidebar-toggle")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveClass(/sidebar-collapsed/);
  });
});
