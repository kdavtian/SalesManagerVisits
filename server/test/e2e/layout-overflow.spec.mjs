import { test, expect, loginViaUi } from "./fixtures.mjs";

// A long / unbreakable name in the top bar used to push the bell and menu buttons off the screen and make the whole page
// scroll sideways; long Armenian tile labels used to spill past their tile's border (found by the 2026-10-16 role crawl).
test.describe("Home layout at phone width", () => {
  test("@smoke a very long user name does not overflow the page and Home tile labels stay inside their tiles", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const user = await fixtures.createUser("warehouse_manager", { name: "Վահագնուշ-Հակոբյանյան_ExtremelyLongSingleWordName" });
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
});
