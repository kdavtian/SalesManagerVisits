import { test, expect, loginViaUi } from "./fixtures.mjs";

// A long / unbreakable name in the top bar used to push the bell and menu buttons off the screen and make the whole page
// scroll sideways; long Armenian tile labels used to spill past their tile's border (found by the 2026-10-16 role crawl).
test.describe("Home layout at phone width", () => {
  test("@smoke a very long user name does not overflow the page and Home tile labels stay inside their tiles", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const user = await fixtures.createUser("ceo", { name: "Վահագնուշ-Հակոբյանյան_ExtremelyLongSingleWordName" });
    await loginViaUi(page, user.email);
    await page.goto("/#/dashboard");
    await expect(page.locator(".quick-actions-grid .quick-action").first()).toBeVisible({ timeout: 15000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.locator("#topbar-menu-btn")).toBeInViewport();

    const spills = await page.evaluate(() =>
      [...document.querySelectorAll(".quick-actions-grid .quick-action")]
        .map((tile) => {
          const label = [...tile.children].find((c) => !c.classList.contains("quick-action-icon"));
          if (!label) return null;
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = tile.getBoundingClientRect();
          return text.left < box.left - 0.5 || text.right > box.right + 0.5 ? label.textContent.trim() : null;
        })
        .filter(Boolean)
    );
    expect(spills).toEqual([]);
  });

  // UI/UX audit 2026-10-16: on 360 px Androids the Customers title was cut to "Հաճախոր…" and the 4th stat pill scrolled off.
  test("Customers header title is not clipped and the four stat pills fit at 360 px", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const user = await fixtures.createUser("admin", { name: "Layout Admin" });
    await loginViaUi(page, user.email);
    await page.goto("/#/customers");
    await expect(page.locator("#customer-stats-bar .stat-pill")).toHaveCount(4, { timeout: 15000 });
    const m = await page.evaluate(() => {
      const h1 = document.querySelector(".list-view .list-header h1");
      const pills = [...document.querySelectorAll("#customer-stats-bar .stat-pill")].map((p) => p.getBoundingClientRect());
      return { clipped: h1.scrollWidth - h1.clientWidth, lastRight: Math.max(...pills.map((r) => r.right)), vw: window.innerWidth };
    });
    expect(m.clipped).toBeLessThanOrEqual(1);
    expect(m.lastRight).toBeLessThanOrEqual(m.vw);
  });
});
