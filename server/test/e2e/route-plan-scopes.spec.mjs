import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-16: "SM B2B Artak" is a plan of its own. One person (Artak) owns SM Davtashen AND SM B2B customers;
// Route Plans shows two cards for him, and each card only lists / edits its own customers.
test.describe("Route plans: separate SM B2B plan", () => {
  test("two plan cards for one person; the B2B picker lists only B2B customers and saving keeps the Davtashen day", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "Scope Artak" });
    const stamp = Date.now();
    const own = (name, channel) => fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, sales_channel: channel, name, erp_customer_id: `E2E-RP-${stamp}-${name}` });
    const dav = await own("Scope Davtashen Shop", "SM Davtashen");
    const b2b = await own("Scope B2B Fleet", "SM B2B");
    await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, 1, '[]', $2, $3, true)", [rep.id, [dav.id], admin.id]);

    try {
      await loginViaUi(page, admin.email);
      await page.goto("/#/route-plans");
      const cards = page.locator(".route-plan-rep-card", { hasText: "Scope Artak" });
      await expect(cards).toHaveCount(2, { timeout: 15000 });
      await expect(cards.nth(1)).toContainText("SM B2B");

      // B2B plan: Monday picker lists only the B2B customer
      await cards.nth(1).locator('.route-plan-day-chip[data-day="1"]').click();
      const list = page.locator("#route-plan-customer-list");
      await expect(list).toContainText("Scope B2B Fleet", { timeout: 10000 });
      await expect(list).not.toContainText("Scope Davtashen Shop");
      // tick the B2B customer (tri-state tree: expand, then check the leaf)
      await page.locator(`[data-leaf-id="${b2b.id}"]`).evaluate((el) => el.click()).catch(async () => {
        await list.locator(".route-plan-tree-row[data-toggle]").first().click();
        await page.locator(`[data-leaf-id="${b2b.id}"]`).check();
      });
      await page.locator("#save-route-plan-picker").click();
      await expect(page.locator("#route-plan-customer-list")).toHaveCount(0, { timeout: 10000 });

      const { rows } = await pool.query("SELECT customer_ids FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = 1", [rep.id]);
      expect(rows[0].customer_ids.sort((a, b) => a - b)).toEqual([dav.id, b2b.id].sort((a, b) => a - b));
    } finally {
      await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
    }
  });
});
