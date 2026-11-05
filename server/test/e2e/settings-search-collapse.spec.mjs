import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-05: Settings search hides like in iOS: hidden when the page opens, a swipe down shows it, a swipe up hides it, it snaps.
test("Settings: the search field starts hidden under the title, shows when pulled down, snaps to the nearer end", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/settings");
  await expect(page.locator("#settings-search")).toBeAttached({ timeout: 15000 });
  const top = () => page.evaluate(() => document.getElementById("app").scrollTop);
  const barVisible = () =>
    page.evaluate(() => {
      const bar = document.getElementById("settings-search").getBoundingClientRect();
      const title = document.getElementById("settings-title").getBoundingClientRect();
      return bar.bottom > title.bottom + 1; // any part of the field is below the pinned title
    });
  await expect.poll(top, { timeout: 5000 }).toBeGreaterThan(30); // hidden at the start
  expect(await barVisible()).toBe(false);
  await page.screenshot({ path: "/tmp/settings-hidden.png" });

  // pull down a little: past the middle it goes back to hidden; before the middle it opens
  await page.evaluate(() => (document.getElementById("app").scrollTop = 40));
  await expect.poll(top, { timeout: 4000 }).toBeGreaterThan(44);
  await page.evaluate(() => (document.getElementById("app").scrollTop = 10));
  await expect.poll(top, { timeout: 4000 }).toBeLessThan(2);
  expect(await barVisible()).toBe(true);
  await page.screenshot({ path: "/tmp/settings-shown.png" });

  // typing keeps it open; the search still works
  await page.locator("#settings-search").fill("password");
  await page.evaluate(() => (document.getElementById("app").scrollTop = 20));
  await page.waitForTimeout(500);
  expect(await top()).toBeLessThan(25);
});
