import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-05 (screenshots): pages scrolled sideways and cut off their left edge. Causes found by crawling every screen and every Settings
// section at 390 px: the Products list (five links in one line), the error log (a long URL / message), and nothing stopped a wide element from
// making the whole page draggable. Now each is fixed at its cause and phones clip as a safety net.
const overflowOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollWidth - el.clientWidth : -1;
  }, selector);

test("Settings > Products and the error log do not scroll sideways at 390 px; the page itself never does", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const stamp = Date.now();
  await pool.query("INSERT INTO products (name, brand, unit, unit_price_amd, silver_price_amd, active, erp_product_id, manually_edited_at) VALUES ('E2E Overflow Castrol EDGE Professional LL IV 0W-30 Երկար անուն', 'Castrol', '208 L', 9000, 8500, true, $1, now())", [`E2E-OV-${stamp}`]);
  await pool.query("INSERT INTO client_error_log (kind, message, url) VALUES ('error', $1, $2)", [
    "ResizeObserverLoop_completed_with_undelivered_notifications_and_a_very_long_token_without_any_space_0123456789",
    "https://kad-app.example/settings?section=a-sales&very=long_unbroken_parameter_value_0123456789012345",
  ]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);

    await page.goto("/#/settings?section=a-finance");
    await page.locator("#row-product-catalog").click();
    await expect(page.locator(".product-admin-row", { hasText: "E2E Overflow" })).toBeVisible({ timeout: 15000 });
    expect(await overflowOf(page, ".admin-section-overlay-body")).toBeLessThanOrEqual(1);
    // a row: tap = edit, "..." = the other actions (no five links in a line)
    const row = page.locator(".product-admin-row", { hasText: "E2E Overflow" });
    await row.locator(".product-admin-more").click();
    await expect(page.locator(".product-action-list .btn")).toHaveCount(4); // promo, history, re-enable auto-sync, deactivate
    const box = await page.locator(".product-action-list .btn").first().boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: "/tmp/products-actions.png" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelectorAll(".sheet-overlay").forEach((e) => e.remove()));

    await page.goto("/#/settings?section=a-system");
    await page.locator("#row-client-error-log").click();
    await expect(page.locator(".dq-row").first()).toBeVisible({ timeout: 15000 });
    expect(await overflowOf(page, ".admin-section-overlay-body")).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "/tmp/error-log.png" });

    // the safety net: a wide element anywhere is clipped, the page is not draggable sideways
    await page.goto("/#/customers");
    await expect(page.locator(".list-view")).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
      const wide = document.createElement("div");
      wide.id = "e2e-wide";
      wide.style.cssText = "width:900px;height:10px;white-space:nowrap";
      document.querySelector(".list-view").appendChild(wide);
    });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("app")).overflowX)).toBe("hidden");
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [`E2E-OV-${stamp}`]);
    await pool.query("DELETE FROM client_error_log WHERE message LIKE 'ResizeObserverLoop_completed%'");
  }
});
