import { test, expect, loginViaUi, pool, TEST_PASSWORD } from "./fixtures.mjs";

// Owner, 2026-10-20: "What can I do when I fire a sales rep?" -> a guided Pause / Switch off in Settings -> Team: the account stays
// (history), login is closed, customers go to other reps region by region, and the rep disappears from the rep lists.
test.describe("Pause or switch off a rep", () => {
  test("@smoke an admin switches a rep off, hands the customers over by region, and switches the account back on", async ({ page, fixtures, browser }, info) => {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "E2E Leaving Rep" });
    const heir = await fixtures.createUser("sales_manager", { name: "E2E Heir Rep" });
    const north = await fixtures.createCustomer({ name: "E2E Off North", created_by: admin.id, assigned_manager_id: rep.id });
    const south = await fixtures.createCustomer({ name: "E2E Off South", created_by: admin.id, assigned_manager_id: rep.id });
    await pool.query("UPDATE customers SET region = 'E2E North' WHERE id = $1", [north.id]);
    await pool.query("UPDATE customers SET region = 'E2E South' WHERE id = $1", [south.id]);

    await page.setViewportSize({ width: 440, height: 900 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings?section=a-team");
    await page.locator("#row-team-management").click();
    await page.locator("#user-list .list-row", { hasText: "E2E Leaving Rep" }).first().click({ timeout: 15000 });
    await page.locator("#edit-user-offboard").click();

    const sheet = page.locator(".sheet", { hasText: "E2E Leaving Rep" });
    await expect(sheet.locator(".offboard-holds")).toContainText("2", { timeout: 10000 });
    await sheet.locator("#offboard-all").selectOption(String(heir.id));
    // the second region goes to nobody: put it back to "leave as it is"
    await sheet.locator('[data-region-index="1"]').selectOption("");
    await sheet.locator('[data-mode="offboarded"]').click();
    await expect(sheet.locator("#offboard-submit")).toHaveText(/switch off/i);
    await sheet.locator("#offboard-submit").click();

    await expect(page.locator(".list-row-off", { hasText: "E2E Leaving Rep" })).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".list-row-off .badge-danger", { hasText: /left/i })).toBeVisible();
    const { rows } = await pool.query("SELECT id, assigned_manager_id FROM customers WHERE id = ANY($1) ORDER BY region", [[north.id, south.id]]);
    const owners = Object.fromEntries(rows.map((r) => [r.id, r.assigned_manager_id]));
    expect(owners[north.id]).toBe(heir.id);
    expect(owners[south.id]).toBe(rep.id);
    expect((await pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe("offboarded");

    // the switched-off rep cannot log in
    const other = await browser.newContext({ baseURL: info.project.use.baseURL });
    const second = await other.newPage();
    await second.goto("/");
    await second.locator('input[name="email"]').fill(rep.email);
    await second.locator('input[name="password"]').fill(TEST_PASSWORD);
    await second.locator('button[type="submit"]').click();
    await expect(second.getByText(/switched off|paused/i)).toBeVisible({ timeout: 10000 });
    await other.close();

    // switch back on
    await page.locator("#user-list .list-row", { hasText: "E2E Leaving Rep" }).first().click();
    await page.locator("#edit-user-reactivate").click();
    await expect.poll(async () => (await pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe("active");
    await expect(page.locator(".list-row-off", { hasText: "E2E Leaving Rep" })).toHaveCount(0);
  });
});
