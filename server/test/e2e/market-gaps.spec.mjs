import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Reports > Gaps and targets (owner, 2026-11-26): a shop with potential and no Castrol on the shelf; management picks it and taps
// "Create visit tasks": its rep gets one task; the row then shows "Task open" and cannot be picked again.
test("gaps: pick a shop without Castrol, create its visit task once; Armenian at 390 and 320 px", async ({ page, fixtures }) => {
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager");
  const director = await fixtures.createUser("sales_director");
  const shop = await fixtures.createCustomer({ name: `GapShop${stamp}`, created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET expected_volume_l = 99999 WHERE id = $1", [shop.id]);
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, brand_status)
     VALUES ($1, $2, 40.18, 44.51, 5, true, '{"castrol":["unavailable"],"competitors":["shell"]}')`,
    [shop.id, rep.id]
  );

  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, director.email);
  await page.goto("/#/reports?r=market_gaps");
  const row = page.locator(".mkt-shop-row", { hasText: `GapShop${stamp}` });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText("Castrol չկա");
  await row.locator('input[type="checkbox"]').check();
  await expect(page.locator("#mkt-make-tasks")).toHaveText("Ստեղծել առաջադրանք (1)");
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-gaps-390.png` });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/market-gaps-320.png` });
  await page.locator("#mkt-make-tasks").click();
  await expect(row.locator(".badge", { hasText: "Առաջադրանքը բաց է" })).toBeVisible({ timeout: 15000 });
  await expect(row.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(page.locator("#mkt-action")).toBeHidden();
  const { rows } = await pool.query("SELECT assignee_id FROM tasks WHERE customer_id = $1 AND status = 'open'", [shop.id]);
  expect(rows.map((r) => r.assignee_id)).toEqual([rep.id]);
  await pool.query("DELETE FROM tasks WHERE customer_id = $1", [shop.id]);
});
