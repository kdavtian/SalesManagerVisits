import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-30: "reopening from the icon goes back to where you were: the last screen, at the same scroll, with its filters, tab and search".
// A fresh start (the address "/" with nothing after it, as the home-screen icon opens it) lands on the last screen instead of Home.
async function leaveAndComeBack(page) {
  // the app going to the background saves the screen (viewMemory.js)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.goto("/"); // a fresh start, like the icon: no screen in the address
}

test("@smoke @iphone a fresh start opens the last screen with its search and scroll; Orders and Activity keep their search too", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("admin");
  const tag = `RO${Date.now().toString(36)}`;
  for (let i = 0; i < 40; i++) await fixtures.createCustomer({ created_by: rep.id, name: `${tag} Shop ${String(i).padStart(2, "0")}` });
  await loginViaUi(page, rep.email);

  // ---- Customers: search + scroll
  await page.goto("/#/customers");
  const search = page.locator("#customer-search");
  await expect(search).toBeVisible();
  await search.fill(tag);
  await expect(page.locator("#customer-list .list-row, #customer-list [data-customer-id]").first()).toBeVisible();
  await page.evaluate(() => (document.getElementById("app").scrollTop = 900));
  await expect.poll(() => page.evaluate(() => document.getElementById("app").scrollTop)).toBeGreaterThan(500);
  const scrolled = await page.evaluate(() => document.getElementById("app").scrollTop);
  await leaveAndComeBack(page);
  await expect(page).toHaveURL(/#\/customers/);
  await expect(page.locator("#customer-search")).toHaveValue(tag);
  await expect.poll(() => page.evaluate(() => document.getElementById("app").scrollTop), { timeout: 8000 }).toBeGreaterThan(scrolled - 150);

  // a reload onto the same screen (what taking an update does) keeps the search too
  await page.reload();
  await expect(page.locator("#customer-search")).toHaveValue(tag);

  // ---- Orders: search
  await page.goto("/#/orders");
  await expect(page.locator("#order-search")).toBeVisible();
  await page.locator("#order-search").fill("zzz-nothing-matches");
  await leaveAndComeBack(page);
  await expect(page).toHaveURL(/#\/orders/);
  await expect(page.locator("#order-search")).toHaveValue("zzz-nothing-matches");

  // ---- Activity: search
  await page.goto("/#/activity");
  await expect(page.locator("#activity-search")).toBeVisible();
  await page.locator("#activity-search").fill("zzz-nobody");
  await leaveAndComeBack(page);
  await expect(page).toHaveURL(/#\/activity/);
  await expect(page.locator("#activity-search")).toHaveValue("zzz-nobody");

  // ---- Home is where Home was: a person who left on Home starts on Home; a link or notification (an address with a screen) is never overridden
  await page.goto("/#/dashboard");
  await expect(page.locator("#top-bar")).toBeVisible();
  await leaveAndComeBack(page);
  await expect(page).not.toHaveURL(/#\/(customers|orders|activity)/);
  await page.goto("/#/tasks");
  await expect(page.locator("#top-bar")).toBeVisible();
  await page.goto("/#/customers");
  await expect(page.locator("#customer-search")).toBeVisible();
});
