import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-20: (1) the freight / customs / excise ... rates of the landing-cost model are editable in App configuration
// (Settings -> Admin Workspace); (2) the long Armenian "Մանրածախ" label on product cards is shortened on phones and tablets
// and kept in full on a computer.
test.describe("Landing-cost rates and the retail label", () => {
  test("an admin changes a rate in App configuration, it is saved, and 'Reset all' puts the built-in values back", async ({ page, fixtures }) => {
    const saved = (await pool.query("SELECT landing_cost_rates FROM app_settings WHERE id = 1")).rows[0]?.landing_cost_rates ?? {};
    try {
      await pool.query("UPDATE app_settings SET landing_cost_rates = '{}'::jsonb WHERE id = 1");
      const admin = await fixtures.createUser("admin");
      await loginViaUi(page, admin.email);
      await page.goto("/#/settings?section=a-finance");
      const details = page.locator("#landing-rates-details");
      await details.locator("summary").click();
      const customs = details.locator('input[name="customs"]');
      await expect(customs).toBeVisible();
      await expect(customs).toHaveValue(""); // untouched: empty, the built-in value is only the placeholder
      await expect(customs).toHaveAttribute("placeholder", "5");

      await customs.fill("10");
      await details.locator('button[type="submit"]').click();
      await expect(page.locator("#landing-rates-success")).toBeVisible();
      await expect.poll(async () => (await pool.query("SELECT landing_cost_rates FROM app_settings WHERE id = 1")).rows[0].landing_cost_rates).toEqual({ customs: 10 });

      // survives a reload
      await page.reload();
      await page.locator("#landing-rates-details summary").click();
      await expect(page.locator('#landing-rates-details input[name="customs"]')).toHaveValue("10");

      // a wrong value is refused by the server and nothing is saved
      page.once("dialog", (d) => d.accept());
      await page.locator('#landing-rates-details input[name="customs"]').fill("500");
      await page.locator('#landing-rates-details button[type="submit"]').click();
      await expect.poll(async () => (await pool.query("SELECT landing_cost_rates FROM app_settings WHERE id = 1")).rows[0].landing_cost_rates).toEqual({ customs: 10 });

      await page.locator("#landing-rates-reset").click();
      await expect.poll(async () => (await pool.query("SELECT landing_cost_rates FROM app_settings WHERE id = 1")).rows[0].landing_cost_rates).toEqual({});
      await expect(page.locator('#landing-rates-details input[name="customs"]')).toHaveValue("");
    } finally {
      await pool.query("UPDATE app_settings SET landing_cost_rates = $1 WHERE id = 1", [JSON.stringify(saved)]);
    }
  });

  test("product cards: the Armenian retail label is short on a phone and a tablet, the full word is kept on a computer", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const product = await fixtures.createProduct({ unit_price_amd: 8000 });
    await pool.query("UPDATE products SET retail_price_amd = 10000, silver_price_amd = 8500 WHERE id = $1", [product.id]);
    await page.setViewportSize({ width: 440, height: 900 });
    await loginViaUi(page, admin.email);
    await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await page.evaluate(() => { location.hash = "#/pricelist"; });
    const card = page.locator(".pricelist-row", { hasText: product.name }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    const short = card.locator(".pl-lbl-short");
    const full = card.locator(".pl-lbl-full");
    await expect(short).toBeVisible();
    // exactly the abbreviation with its own full stop: no colon after it
    await expect(short).toHaveText("Մանր.");
    await expect(full).toBeHidden();

    // a tablet is still below the computer layout (1024 px) and keeps the cards
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(card.locator(".pl-lbl-short")).toBeVisible();

    // a computer shows the table with the full word in its column header
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { location.hash = "#/"; });
    await page.evaluate(() => { location.hash = "#/pricelist"; });
    await expect(page.locator("th", { hasText: "Մանրածախ" }).first()).toBeVisible();
  });
});
