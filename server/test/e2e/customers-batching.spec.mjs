import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Performance (owner, 2026-10-17: "find possible slowing causes"): the Customers list builds 100 cards first and appends the
// rest as it is scrolled; 4,000 cards at once froze a phone for seconds.
test.describe("Customers list is built in batches", () => {
  test("100 first, more while scrolling, search starts again", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const tag = `BATCH${Date.now()}`;
    await pool.query(
      `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng, erp_customer_id, region)
       SELECT '${tag} Customer ' || lpad(g::text, 3, '0'), 'SM YVN', $1, $1, 40.1 + g * 0.0001, 44.5, '${tag}-' || g, 'Yerevan' FROM generate_series(1, 260) g`,
      [admin.id]
    );
    try {
      await loginViaUi(page, admin.email);
      await page.goto("/#/customers");
      await page.locator("#customer-search").fill(tag);
      await expect.poll(async () => page.locator("#customer-list .list-row").count(), { timeout: 10000 }).toBe(100);

      // scroll to the end: the rest arrives batch by batch
      await expect.poll(
        async () => {
          await page.evaluate(() => document.querySelector("#customer-list .list-row:last-of-type")?.scrollIntoView({ block: "end" }));
          await page.waitForTimeout(250);
          return page.locator("#customer-list .list-row").count();
        },
        { timeout: 15000 }
      ).toBe(260);

      // a new search starts from the first batch again, and tapping a card (appended later too) opens the customer
      await page.locator("#customer-search").fill(`${tag} Customer 250`);
      await expect.poll(async () => page.locator("#customer-list .list-row").count()).toBe(1);
      await page.locator("#customer-list .list-row").first().click();
      await expect(page).toHaveURL(/#\/customers\/\d+/);
    } finally {
      await pool.query("DELETE FROM customers WHERE erp_customer_id LIKE $1", [`${tag}-%`]);
    }
  });
});
