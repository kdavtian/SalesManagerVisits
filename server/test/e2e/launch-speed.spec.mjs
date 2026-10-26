import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-26 ("takes like 5 seconds to open the app, white screen"): each launch leaves its timings on the phone and Settings > About shows them,
// so a slow start can be measured on the phone itself instead of guessed at.
test("Settings > About lists how long the launches took", async ({ page, fixtures }) => {
  const manager = await fixtures.createUser("sales_manager");
  await loginViaUi(page, manager.email);
  await page.goto("/");
  // the record is written the moment the header + tab bar (or desktop sidebar) first appear
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("fv_launch_timings") || "[]").length)).toBeGreaterThan(0);
  await page.goto("/#/settings?section=p-about");
  const row = page.locator("#row-launch-speed");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/launch-speed-row.png` });
  await expect(row.locator(".settings-row-value")).toHaveText(/\d+\.\d s/);
  await row.click();
  const popup = page.locator(".info-popup");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/launch-speed-popup.png` });
  await expect(popup).toContainText("White screen");
  await expect(popup).toContainText("App ready");
  await expect(popup.locator("p").first()).toContainText(/v1\.\d+\.\d+/);
});
