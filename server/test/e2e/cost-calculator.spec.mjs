import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17: a cost & margin calculator on the Products page, net cost per pack. 2026-10-18: Royal, sales channel
// commissions, per-brand freight, cost items from the cash ledger, two VAT methods, sectioned settings with the methodology.
test.describe("Cost & margin calculator", () => {
  test("catalog product, channel commission, Royal, settings sections and custom cost; reps never see it", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const p = await fixtures.createProduct({ name: "CalcTest Edge 4L", brand: "Castrol", unit: "4L", unit_price_amd: 35000 });
    await pool.query("UPDATE products SET silver_price_amd=31000, bronze_price_amd=35000, gold_price_amd=24000, landing_cost_amd=14033, net_cost_amd=28170 WHERE id=$1", [p.id]);

    await loginViaUi(page, admin.email);
    await page.goto("/#/pricelist");
    await page.locator("#calc-btn").click();
    await page.locator("#cc-search").fill("CalcTest");
    await page.locator(".cc-result").first().click();
    // silver price is the default; net cost is per pack at the dearest channel (4 %), VAT-payer method (default): 25,109, and the Excel's 28,170 is shown for comparison
    await expect(page.locator("#cc-price")).toHaveValue("31000");
    await expect(page.locator(".cc-figs")).toContainText("25,109");
    await expect(page.locator(".cc-figs")).toContainText("28,170");
    // the other method is always on one line under the figures
    await expect(page.locator(".cc-alt")).toContainText("26,731");
    // every price level in one table; tapping a row tries that price
    await expect(page.locator(".cc-levels .cc-level")).toHaveCount(4);
    await page.locator('.cc-level[data-tier="gold"]').click();
    await expect(page.locator("#cc-price")).toHaveValue("24000");
    await page.locator('.cc-level[data-tier="silver"]').click();
    await expect(page.locator("#cc-price")).toHaveValue("31000");

    // the channel decides the commission: CVO 2 % saves 620, CAS 0 % saves 1,240
    await page.locator("#cc-channel").selectOption("CVO");
    await expect(page.locator(".cc-figs")).toContainText("24,601");
    await page.locator("#cc-channel").selectOption("CAS");
    await expect(page.locator(".cc-figs")).toContainText("24,092");
    await page.locator("#cc-channel").selectOption("SM YVN");
    await expect(page.locator(".cc-figs")).toContainText("25,109");

    // the workbook method (the owner's choice since 1.359.0 is the VAT payer; this one counts import VAT twice)
    await page.locator('#cc-method [data-vat="workbook"]').click();
    await expect(page.locator(".cc-figs")).toContainText("26,731");

    // a lower price lowers the net margin; below cost warns
    await page.locator("#cc-price").fill("15000");
    await expect(page.locator(".cc-warn").first()).toBeVisible();

    // new product: Royal has its own freight; Castrol reproduces the workbook's landing cost (Edge Professional EC 4 L = 14,033)
    await page.locator('#cc-modes [data-mode="new"]').click();
    await expect(page.locator("#cc-brands [data-brand]")).toHaveCount(5);
    await page.locator("#cc-size").fill("4");
    await page.locator("#cc-items").fill("4");
    await page.locator("#cc-kg").fill("13.48");
    await page.locator("#cc-cost").fill("87.56");
    await page.locator("#cc-price").fill("31000");
    await expect(page.locator(".cc-figs")).toContainText("13,690"); // at the market rate 366 (the workbook's 377.5 gives 14,033)
    await expect(page.locator(".cc-figs")).toContainText("26,506");
    await page.locator('#cc-brands [data-brand="Royal"]').click();
    await expect(page.locator(".cc-figs")).not.toContainText("13,690"); // dearer freight (0.40 vs 0.252 USD/kg) and 0.35 legal transport
    await page.locator('#cc-brands [data-brand="Castrol"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // settings: sections, the measured cost items, a custom cost raises the net cost, the methodology is there
    await page.locator("#cc-gear").click();
    const settings = page.locator(".cc-settings");
    await expect(settings.locator("details.cc-sec")).toHaveCount(7);
    await settings.locator('details[data-sec="items"] summary').click();
    await expect(settings.locator(".cc-item")).toHaveCount(9);
    await expect(settings.locator('details[data-sec="items"] summary small')).toContainText("17.49%");
    await settings.locator("#cc-add-name").fill("Warehouse rent");
    await settings.locator("#cc-add-kind").selectOption("pack");
    await settings.locator("#cc-add-val").fill("1000");
    await settings.locator("#cc-add-btn").click();
    await expect(settings.locator(".cc-item")).toHaveCount(10);
    await settings.locator('details[data-sec="method"] summary').click();
    await expect(settings.locator(".cc-method-doc")).toContainText("17.49%");
    await settings.locator('[data-action="close"]').last().click();
    await expect(page.locator(".cc-figs")).toContainText("27,506"); // 26,506 + 1,000 per pack (workbook method, new-product mode)
    await expect(page.locator("#cc-custom")).toBeVisible();

    // the products API shows the new net cost to management and nothing cost-related to a rep
    const adminList = await page.evaluate(async () => (await (await fetch("/api/products")).json()).find((x) => x.name === "CalcTest Edge 4L"));
    expect(adminList.net_cost_amd).toBe(25109);
    expect(adminList.net_cost_workbook_amd).toBe(28170);
    await fixtures.trackRow?.("products", p.id);

    await page.context().clearCookies();
    await loginViaUi(page, rep.email);
    await page.goto("/#/pricelist");
    await expect(page.locator("#export-btn")).toBeVisible();
    await expect(page.locator("#calc-btn")).toHaveCount(0);
    const repRow = await page.evaluate(async () => (await (await fetch("/api/products")).json()).find((x) => x.name === "CalcTest Edge 4L"));
    expect(repRow.net_cost_amd).toBeUndefined();
    expect(repRow.landing_cost_amd).toBeUndefined();
  });
});
