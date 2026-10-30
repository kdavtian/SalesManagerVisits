import { test, expect } from "./fixtures.mjs";

// Owner, 2026-10-30: after an update a white screen, then "Reload" spun for ever (the boot spinner has no end when a script of the app does not
// load). bootGate.js now starts clean by itself once (stored files thrown away, downloaded again) and, when that was not enough, shows a card
// with a Clean reload button instead of a spinner.
test("@smoke @iphone an app that cannot start shows a Clean reload card, never a spinner for ever", async ({ browser }) => {
  const base = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3101"}`;
  const context = await browser.newContext({
    baseURL: base,
    serviceWorkers: "block", // so the page's own requests are the ones this test answers
    extraHTTPHeaders: { "x-e2e-rate-limit-bypass": process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass" },
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "en"));
    let broken = true;
    await context.route("**/js/app.js*", (route) => (broken ? route.fulfill({ status: 404, body: "gone" }) : route.continue()));
    await page.goto("/");
    // the first failure starts clean by itself (a reload); the second one is the card
    await expect(page.locator("#boot-clean")).toBeVisible({ timeout: 30000 });
    await expect(page.locator(".boot-splash")).toHaveCount(0);
    await expect(page.locator("#boot-reload")).toBeVisible();
    // the files are back: one tap starts the app
    broken = false;
    await page.locator("#boot-clean").click();
    await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15000 });
  } finally {
    await context.close();
  }
});
