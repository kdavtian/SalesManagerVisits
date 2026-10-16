import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17: a cost & margin calculator on the Products page (like the Landing Cost & Margin artifact), and the
// net cost computed per pack.
test.describe("Cost & margin calculator", () => {
  test("catalog product -> corrected net cost; new product -> landing cost from the workbook rules; reps never see it", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const p = await fixtures.createProduct({ name: "CalcTest Edge 4L", brand: "Castrol", unit: "4L", unit_price_amd: 35000 });
    await pool.query("UPDATE products SET silver_price_amd=31000, bronze_price_amd=35000, landing_cost_amd=14033, net_cost_amd=28170 WHERE id=$1", [p.id]);

    await loginViaUi(page, admin.email);
    await page.goto("/#/pricelist");
    await page.locator("#calc-btn").click();
    await page.locator("#cc-search").fill("CalcTest");
    await page.locator(".cc-result").first().click();
    // silver price is the default; net cost is per pack (24,270), not the Excel's 28,170
    await expect(page.locator("#cc-price")).toHaveValue("31000");
    await expect(page.locator(".cc-figs")).toContainText("24,270");
    await expect(page.locator(".cc-figs")).toContainText("28,170"); // shown as "Excel: ..." for comparison
    // a lower price lowers the net margin; below cost warns
    await page.locator("#cc-price").fill("15000");
    await expect(page.locator(".cc-warn").first()).toBeVisible();

    // new product: the workbook's landing cost (Edge Professional EC 4 L = 14,033)
    await page.locator('#cc-modes [data-mode="new"]').click();
    await page.locator("#cc-size").fill("4");
    await page.locator("#cc-items").fill("4");
    await page.locator("#cc-kg").fill("13.48");
    await page.locator("#cc-cost").fill("87.56");
    await page.locator("#cc-price").fill("31000");
    await expect(page.locator(".cc-figs")).toContainText("14,033");
    await expect(page.locator(".cc-figs")).toContainText("24,270");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // the products API shows the corrected net cost to management and nothing cost-related to a rep
    const adminList = await page.evaluate(async () => (await (await fetch("/api/products")).json()).find((x) => x.name === "CalcTest Edge 4L"));
    expect(adminList.net_cost_amd).toBe(24270);
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
