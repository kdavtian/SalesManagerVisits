import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-29: "let user rearrange home buttons in his settings". Settings > Home buttons moves a tile up; Home shows the new
// order, and it is kept on the server for this person (a new sign-in on another device gets it too).
test("@smoke Settings > Home buttons: a tile moved to the top is first on Home, kept after signing in again", async ({ page, browser, baseURL, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  await expect(page.locator(".quick-actions-grid .quick-action").first()).toBeVisible({ timeout: 15000 });
  const tiles = () => page.locator(".quick-actions-grid .quick-action").evaluateAll((els) => els.map((el) => el.id));
  const before = await tiles();
  expect(before.length).toBeGreaterThan(2);
  const second = before[1];

  await page.goto("/#/settings?section=p-appearance");
  await page.locator("#row-home-order").click();
  const rows = page.locator(".home-order-row");
  await expect(rows).toHaveCount(before.length);
  const save = page.waitForResponse((r) => r.url().endsWith("/api/me/home-order") && r.request().method() === "PUT");
  await rows.nth(1).locator('[data-move="-1"]').click();
  await expect(rows.first()).toHaveAttribute("data-id", second.replace(/-/g, "_"));
  expect((await save).status()).toBe(200);
  await page.locator("#home-order-done").click();

  await page.goto("/#/dashboard");
  await expect.poll(async () => (await tiles())[0]).toBe(second);

  // another device: a fresh sign-in gets the same order from the server
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-e2e-rate-limit-bypass": process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass" } });
  const p2 = await other.newPage();
  await p2.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(p2, rep.email);
  await expect.poll(async () => p2.locator(".quick-actions-grid .quick-action").first().getAttribute("id"), { timeout: 15000 }).toBe(second);
  await other.close();
});
