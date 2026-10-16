import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17: Debt balances -- date button in the header (right), one channel + rep filter, full customer names,
// nothing wider than the screen.
test.describe("Debt balances page", () => {
  test("header date button, channel/rep filter narrows list and totals, long names are not cut", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    const repA = await fixtures.createUser("sales_manager");
    const repB = await fixtures.createUser("sales_manager");
    const stamp = Date.now();
    const erp = [];
    const longName = "Very Long Customer Name Avtoservis Armenia Limited Liability Company Yerevan Branch";
    for (const [name, who, channel, debt] of [[longName, repA, "SM YVN", 700000], ["Shirak Garage", repB, "SM Shirak", 300000]]) {
      const id = `E2E-DEBT-${stamp}-${erp.length}`;
      erp.push(id);
      await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: who.id, erp_customer_id: id, name, sales_channel: channel });
      await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1,$2,$3,0,now())", [id, name, debt]);
    }
    try {
      await loginViaUi(page, admin.email);
      await page.goto("/#/debt-balances");
      await expect(page.locator(".debt-balance-card")).toHaveCount(2, { timeout: 10000 });

      // the date button sits in the header row, on the right of the title
      const title = await page.locator(".debt-header h1").boundingBox();
      const dateBtn = await page.locator("#debt-as-of-filter-wrap").boundingBox();
      expect(Math.abs((dateBtn.y + dateBtn.height / 2) - (title.y + title.height / 2))).toBeLessThan(30);
      expect(dateBtn.x).toBeGreaterThan(title.x + title.width - 1);
      expect(dateBtn.x + dateBtn.width).toBeGreaterThan(400);
      expect(dateBtn.height).toBeGreaterThanOrEqual(44);

      // full customer name (wraps, never ellipsised)
      await expect(page.locator(".debt-name", { hasText: "Very Long Customer Name" })).toContainText("Yerevan Branch");
      const nameBox = await page.locator(".debt-name", { hasText: "Very Long" }).boundingBox();
      expect(nameBox.height).toBeGreaterThan(30);
      // nothing overflows the screen sideways
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // channel -> rep filter: pick the Shirak channel only
      await page.locator("#debt-assign-filter-btn").click();
      await page.locator(".route-plan-tree-row[data-toggle]", { hasText: "SM Shirak" }).locator(".route-plan-tree-check").check();
      await page.locator("#tree-sheet-done").click();
      await expect(page.locator(".debt-balance-card")).toHaveCount(1);
      await expect(page.locator(".debt-balance-card")).toContainText("Shirak Garage");
      await expect(page.locator("#debt-total-amount")).toContainText("300,000");
      await expect(page.locator("#debt-assign-filter-btn")).toHaveClass(/filter-icon-btn-active/);
    } finally {
      await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erp]);
    }
  });
});
