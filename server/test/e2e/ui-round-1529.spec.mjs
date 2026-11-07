import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-07 (1.529.0): after an update Customers said "null is not an object (evaluating 'qe.user.role')" and Orders "The screen did
// not open": a screen opened for the first time came from the new files while the page still ran the old ones, and got its own empty state.

test("@smoke a second copy of the app's state shares the signed-in user instead of starting empty", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await expect(page.locator("#app > *").first()).toBeVisible({ timeout: 15000 });
  const result = await page.evaluate(async () => {
    const first = await import("/js/state.js");
    const copy = await import("/js/state.js?copy=1"); // what a screen of newer files evaluates: its own copy of the module
    return { same: copy.state === first.state, role: copy.state.user?.role, url: location.search };
  });
  expect(result.same, "one state for the whole page").toBe(true);
  expect(result.role).toBe("admin");
  expect(result.url, "nothing reloaded: the copy found the same version").toBe("");
});

test("@smoke an older page (no shared state) meeting a newer copy starts clean by itself, once", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await expect(page.locator("#app > *").first()).toBeVisible({ timeout: 15000 });
  // an older page never set the page-wide state: the newer copy finds a booted page without it
  await page.evaluate(() => {
    delete globalThis.__fvState;
    delete globalThis.__fvVersion;
    sessionStorage.removeItem("fv_mix_reload");
  });
  await page.evaluate(() => import("/js/state.js?copy=2"));
  await page.waitForURL(/fv_retry=/, { timeout: 15000 });
  await expect(page.locator("#top-bar")).toBeVisible({ timeout: 15000 }); // back in the app, still signed in
  // a second mix inside the minute does not reload again (never a loop)
  const stayed = await page.evaluate(async () => {
    globalThis.__noReload = true; // a reload would wipe it
    delete globalThis.__fvState;
    document.documentElement.dataset.fvBooted = "1";
    await import("/js/state.js?copy=3");
    await new Promise((r) => setTimeout(r, 4500));
    return globalThis.__noReload === true;
  });
  expect(stayed).toBe(true);
});
