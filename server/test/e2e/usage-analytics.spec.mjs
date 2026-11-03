import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Usage analytics (owner, 2026-11-03): OFF by default; once the admin's switch is on the app reports screens, time and taps; the report shows them.
test("@iphone usage analytics: switch on, browse, the report lists the screens and the tapped tab", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await pool.query("INSERT INTO app_settings (id, usage_analytics_enabled) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET usage_analytics_enabled = true");
  await pool.query("DELETE FROM usage_events WHERE user_id = $1", [admin.id]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/dashboard");
    await page.waitForTimeout(1500);
    await page.locator('.nav-item[data-hash="#/customers"]').click();
    await page.waitForTimeout(1500);
    // the app goes to the background: the batch is sent at once
    const sent = page.waitForResponse((r) => r.url().includes("/api/usage/events") && r.request().method() === "POST");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect((await sent).status()).toBe(200);
    const { rows } = await pool.query("SELECT kind, target, seconds FROM usage_events WHERE user_id = $1", [admin.id]);
    expect(rows.some((r) => r.kind === "tap" && r.target === "nav:#/customers")).toBe(true);
    expect(rows.some((r) => r.kind === "page" && r.target === "#/dashboard")).toBe(true);
    await page.evaluate(() => Object.defineProperty(document, "hidden", { value: false, configurable: true }));
    await page.goto("/#/usage-report");
    await expect(page.locator(".usage-row").first()).toBeVisible();
    await expect(page.locator("#usage-body")).toContainText("#/dashboard");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/usage-report.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await pool.query("UPDATE app_settings SET usage_analytics_enabled = false WHERE id = 1");
    await pool.query("DELETE FROM usage_events WHERE user_id = $1", [admin.id]);
  }
});
