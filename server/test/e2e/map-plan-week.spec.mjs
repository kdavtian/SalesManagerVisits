import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Improvement plan 0.2 (2026-11-28): browsing weekdays in the Map's "Plan day > every week" tab used to save the day being
// left with areas only, which wiped the customers that day got on the Route Plans screen. Now browsing saves nothing; an
// edited day asks first, and even a save keeps the day's customers.
test.describe("Map: plan every week", () => {
  test("browsing weekdays keeps the Route Plans customers; an edited day asks before it is left", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rep = await fixtures.createUser("sales_manager");
    const c1 = await fixtures.createCustomer({ created_by: rep.id });
    const c2 = await fixtures.createCustomer({ created_by: rep.id });
    await pool.query("UPDATE customers SET region = 'Yerevan' WHERE id = ANY($1)", [[c1.id, c2.id]]);
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    for (const d of allDays) {
      await pool.query(
        "INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, $2, '[]', $3, $1, true)",
        [rep.id, d, [c1.id, c2.id]]
      );
    }
    const ruleIds = async () => (await pool.query("SELECT day_of_week, customer_ids, areas, active FROM visit_plan_rules WHERE user_id = $1 ORDER BY day_of_week", [rep.id])).rows;
    try {
      await loginViaUi(page, rep.email);
      await page.evaluate(() => (location.hash = "#/map"));
      await page.locator("#plan-day-btn").click();
      await page.locator('.plan-mode-tab[data-mode="recurring"]').click();
      await expect(page.locator("#weekday-picker")).toBeVisible();

      // browse every weekday without editing: no prompt, nothing written
      let dialogs = 0;
      page.on("dialog", (d) => {
        dialogs += 1;
        d.dismiss();
      });
      for (const btn of await page.locator(".weekday-btn").all()) {
        await btn.click();
        await expect(page.locator("#weekday-picker")).toBeVisible();
      }
      expect(dialogs).toBe(0);
      for (const r of await ruleIds()) {
        expect(r.customer_ids.length).toBe(2);
        expect(r.active).toBe(true);
      }

      // edit a day, then switch away: asked; "Cancel" leaves it unsaved
      await page.locator("#plan-add-region").selectOption("Yerevan");
      await page.locator("#plan-add-area-btn").click();
      const current = Number(await page.locator(".weekday-btn-active").getAttribute("data-day"));
      const other = page.locator(`.weekday-btn:not(.weekday-btn-active)`).first();
      await other.click();
      await expect.poll(() => dialogs).toBe(1);
      expect((await ruleIds()).find((r) => r.day_of_week === current).areas).toEqual([]);

      // Save on a day with customers adds the area and keeps both customers
      await page.locator("#plan-add-region").selectOption("Yerevan");
      await page.locator("#plan-add-area-btn").click();
      const saved = Number(await page.locator(".weekday-btn-active").getAttribute("data-day"));
      await page.locator("#save-plan-day").click();
      await expect(page.locator("#plan-body")).toHaveCount(0);
      const row = (await ruleIds()).find((r) => r.day_of_week === saved);
      expect(row.areas).toEqual([{ region: "Yerevan", subregion: null }]);
      expect(row.customer_ids.length).toBe(2);
    } finally {
      await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
    }
  });
});
