import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-05: Orders "loads for ever" when the app is opened cold from the icon (a second tap fixed it). Safari can leave
// indexedDB.open() pending; the list used to wait for its saved copy before it asked the server. The server request now starts at once.
test.use({ serviceWorkers: "block" }); // the page code comes straight from the server, never from an older copy

test("@smoke Orders opens even when the browser's saved-list storage never answers", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, ...rest) => {
      if (name === "fieldvisits_list_cache") return {}; // a request that never fires onsuccess / onerror
      return open(name, ...rest);
    };
  });
  await page.goto("/#/orders");
  await page.reload();
  await expect(page.locator("#orders-list")).toBeVisible({ timeout: 10000 }); // the screen is there first...
  await expect(page.locator("#orders-list .loading-state")).toHaveCount(0, { timeout: 8000 }); // ...then the answer replaces "Loading"
});
