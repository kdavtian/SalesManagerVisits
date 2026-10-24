import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-24: on iPhone a tap on the status bar (not only the spot under the front camera) scrolls to the top. The system gesture scrolls the DOCUMENT
// to 0; the app rests the document at 1 px and turns that scroll into a scroll of the real list. (A desktop browser cannot tap the iOS status bar: the test
// scrolls the document itself.)
test("a document scroll to 0 scrolls the page to its top and the document returns to 1 px; typing does not trigger it", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.setViewportSize({ width: 390, height: 600 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/settings");
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(async () => {
    const m = await import("/js/statusBarTap.js");
    window.__installed = m.installStatusBarTap({ force: true });
  });
  expect(await page.evaluate(() => window.__installed)).toBe(true);
  await page.waitForTimeout(1000);
  // the document has exactly 1 px of room and rests at the bottom of it
  expect(await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight - document.documentElement.clientHeight])).toEqual([1, 1]);

  // the page is scrolled down; the "status bar tap" scrolls the document to 0
  await page.evaluate(() => { document.getElementById("app").scrollTop = 400; });
  expect(await page.evaluate(() => document.getElementById("app").scrollTop)).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => document.getElementById("app").scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1);

  // while an input has focus (keyboard opening / closing) iOS resets the scroll by itself: the page must stay where it is
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "tmp-typing";
    document.body.appendChild(input);
    document.getElementById("app").scrollTop = 300;
    input.focus();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.getElementById("app").scrollTop)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.scrollY)).toBe(1);
});
