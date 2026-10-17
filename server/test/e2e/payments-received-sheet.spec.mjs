import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17 (screenshot): the "Payments received" sheet scrolled sideways, cut the dates off and put the amount of an
// app payment on two lines because of its long "App - Awaiting approval" chip.
test.describe("Payments received sheet", () => {
  test("nothing overflows sideways, dates and amounts stay on one line, app chip sits under the date", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const erpId = `E2E-PR-${Date.now()}`;
    const customer = await fixtures.createCustomer({ created_by: admin.id, name: "10261 Qanaqer / Arkadi", erp_customer_id: erpId });
    await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1,'x',500000,0,now())", [erpId]);
    await page.route(`**/api/customers/${customer.id}/payments-received`, (route) =>
      route.fulfill({
        json: {
          total_amd: 1234000,
          rows: [
            { date: "2026-10-16", source: "app", status: "pending", amount_amd: 15000 },
            { date: "2026-10-13", source: "excel", amount_amd: 6000 },
            { date: "2026-10-02", source: "excel", amount_amd: 20000 },
            { date: "2026-08-03", source: "excel", amount_amd: 1500000 },
          ],
        },
      })
    );
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await page.locator('[data-stat="debt"]').click();
    const list = page.locator(".payments-received-list");
    await expect(list).toBeVisible();
    await page.waitForTimeout(500);
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const amount of await list.locator(".text-amount").all()) {
      const box = await amount.boundingBox();
      expect(box.height).toBeLessThan(26); // one line
    }
    const first = list.locator(".payments-received-row").first();
    const date = await first.locator(".payments-received-date").boundingBox();
    const chip = await first.locator(".badge").boundingBox();
    expect(date.x).toBeGreaterThanOrEqual(0);
    expect(chip.y).toBeGreaterThan(date.y + date.height - 2); // chip under the date
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
    await page.screenshot({ path: "/tmp/claude-0/-home-user-SalesManagerVisits/08fd2df5-8bf9-5eeb-b90f-88ec5281d22b/scratchpad/shots/pay-recv.png" });
  });
});
