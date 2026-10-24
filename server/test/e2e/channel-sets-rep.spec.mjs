import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: on the customer card, changing the sales channel also sets the rep to that channel's owner; the rep can be changed by hand afterwards.
test("changing the sales channel in Account settings sets the rep to the channel's owner; a manual choice wins", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const yvn = await fixtures.createUser("sales_manager", { name: "E2E Yvn Owner" });
  const shirak = await fixtures.createUser("sales_manager", { name: "E2E Shirak Owner" });
  const before = (await pool.query("SELECT code, manager_user_id FROM sales_channels WHERE code IN ('SM YVN', 'SM Shirak', 'OEM')")).rows;
  await pool.query("UPDATE sales_channels SET manager_user_id = $1 WHERE code = 'SM YVN'", [yvn.id]);
  await pool.query("UPDATE sales_channels SET manager_user_id = $1 WHERE code = 'SM Shirak'", [shirak.id]);
  await pool.query("UPDATE sales_channels SET manager_user_id = NULL WHERE code = 'OEM'");
  try {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: yvn.id, name: "E2E Channel Rep Customer", sales_channel: "SM YVN" });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${c.id}`);
    await page.locator("#account-settings-btn").click();
    const manager = page.locator("#reassign-manager");
    await expect(manager.locator("option", { hasText: "E2E Shirak Owner" })).toHaveCount(1, { timeout: 10000 });
    await expect(manager).toHaveValue(String(yvn.id));

    await page.locator('select[name="sales_channel"]').selectOption("SM Shirak");
    await expect(manager).toHaveValue(String(shirak.id));

    // a channel nobody owns leaves the rep as it is
    await page.locator('select[name="sales_channel"]').selectOption("OEM");
    await expect(manager).toHaveValue(String(shirak.id));

    // the rep can be changed by hand afterwards and that is what is saved
    await page.locator('select[name="sales_channel"]').selectOption("SM Shirak");
    await manager.selectOption(String(yvn.id));
    await page.locator('#account-settings-form button[type="submit"]').click();
    await expect.poll(async () => (await pool.query("SELECT sales_channel, assigned_manager_id FROM customers WHERE id = $1", [c.id])).rows[0]).toEqual({ sales_channel: "SM Shirak", assigned_manager_id: yvn.id });
  } finally {
    for (const row of before) await pool.query("UPDATE sales_channels SET manager_user_id = $2 WHERE code = $1", [row.code, row.manager_user_id]);
  }
});
