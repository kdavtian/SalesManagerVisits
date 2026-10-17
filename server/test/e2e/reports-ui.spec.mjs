import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-18: "go through all reports and improve them" -- compact grouped list, info behind "!", period as tabs.
test.describe("Reports UI v2", () => {
  test("the reports list is grouped, one short row per report, description behind !", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/reports");
    await expect(page.locator(".report-list-card").first()).toBeVisible({ timeout: 10000 });
    expect(await page.locator(".report-group-title").count()).toBeGreaterThan(2);
    const rows = await page.locator(".report-item").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.max(...rows)).toBeLessThan(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.locator(".report-item-info").first().click();
    await expect(page.locator(".info-popup")).toContainText(/\S{10}/);
    await page.locator(".info-popup [data-action=close]").click();
    await page.locator(".report-list-card").first().click();
    await expect(page).toHaveURL(/#\/reports\?r=/);
  });

  test("the payments report period is Activity-style tabs and reloads on tap", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    const periods = [];
    page.on("request", (r) => {
      const m = /\/api\/reports\/payments.*[?&]period=(\w+)/.exec(r.url());
      if (m) periods.push(m[1]);
    });
    await page.goto("/#/reports?r=payments");
    await expect(page.locator(".report-period-tabs .activity-tab-active")).toHaveCount(1);
    await expect(page.locator(".report-filter-form select[name=period]")).toHaveCount(0);
    await page.locator('.report-period-tabs [data-period-value="week"]').click();
    await expect(page.locator(".report-period-tabs .activity-tab-active")).toHaveAttribute("data-period-value", "week");
    await expect.poll(() => periods.includes("week")).toBe(true);
    const h = await page.locator(".report-period-tabs .activity-tab").first().evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);
  });
});
