import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-29/30: "on desktop Settings is not opening, just spinning". A screen whose code does not arrive within a few seconds
// shows a bar with Reload / Clean reload, the step it hung on is reported (System health > app errors), and the screen still opens
// when the code arrives.
test("@smoke a screen that is slow to open shows Reload / Clean reload and reports the step it waits on", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.setViewportSize({ width: 1280, height: 800 });
  // set up before signing in: the app also fetches screens in the background right after start, and that fetch must wait too
  await page.route(/\/js\/views\/settings\.js(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 11000));
    await route.continue();
  });
  await loginViaUi(page, admin.email);
  const report = page.waitForRequest((r) => r.url().endsWith("/api/client-errors") && r.method() === "POST" && r.postDataJSON()?.kind === "slow_screen", { timeout: 15000 });
  await page.locator("#topbar-menu-btn").click();
  await expect(page.locator(".slow-route-bar")).toBeVisible({ timeout: 9000 });
  await expect(page.locator("#slow-route-clean")).toBeVisible();
  expect((await report).postDataJSON().message).toMatch(/#\/settings .*step: code/);
  // the code arrives: the screen opens and the bar goes
  await expect(page.locator(".settings-view")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".slow-route-bar")).toHaveCount(0);
});
