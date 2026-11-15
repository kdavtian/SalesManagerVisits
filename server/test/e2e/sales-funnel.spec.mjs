import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Vaghinak - Sales Expert, step 1 (owner, 2026-11-15): the sales funnel screen. Four stages with counts, a stage's customers below, and the
// stage rules (with their numbers) behind the "!" button. Management only.
test("sales funnel: four stages, a potential customer listed on stage 1, the rules sheet with its numbers", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const c = await fixtures.createCustomer({ name: "Funnel Shop E2E", created_by: admin.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'potential', potential_level = 4 WHERE id = $1", [c.id]);
  await loginViaUi(page, admin.email);
  await page.goto("/#/funnel");
  await expect(page.locator(".fn-stage")).toHaveCount(4, { timeout: 10000 });
  const row = page.locator(`.fn-row[data-customer="${c.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator(".fn-detail")).toContainText(/High potential|Բարձր/);
  // nothing sticks out at phone width
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator("#fn-info").click();
  await expect(page.locator(".fn-rules li")).toHaveCount(4);
  await expect(page.locator('input[name="funnelGroupsGold"]')).toHaveValue("6");

  const res = await page.request.get("/api/funnel");
  expect(res.ok()).toBeTruthy();
});
