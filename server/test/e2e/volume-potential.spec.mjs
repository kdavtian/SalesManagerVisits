import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Customer volume potential, phase 1 (owner, 2026-11-17): the rep opens the folded "Volume potential" part of the Potential card, fills
// the editor sheet (total + two product lines), saves; then changes it with no signal: saved on the phone, sent when the signal is back;
// then the Opportunities report lists the customer.
test("a rep fills the volume potential, then edits it offline and it syncs @smoke", async ({ page, context, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  const rep = await fixtures.createUser("sales_manager");
  const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Potential Ararat" });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/customers/${c.id}`);

  const head = page.locator(".vp-head");
  await expect(head).toBeVisible({ timeout: 15000 });
  await head.click();
  await page.locator("[data-vp-edit-open]").click();
  const form = page.locator("#vp-form");
  await expect(form).toBeVisible();
  await form.locator('input[name="cars_per_month"]').fill("120");
  await form.locator('input[name="total_l"]').fill("100");
  await form.locator("input.vp-amount").nth(0).fill("40");
  await form.locator("input.vp-amount").nth(1).fill("20");
  // 60 of 100: more than 15 % apart -> a soft warning, saving still allowed
  await expect(form.locator(".vp-sum")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("vp-sheet-hy.png") });
  await form.locator('button[type="submit"]').click();
  await expect(form).toHaveCount(0, { timeout: 10000 });

  const saved = async () => (await pool.query("SELECT expected_volume_l::float8 AS l FROM customers WHERE id = $1", [c.id])).rows[0].l;
  await expect.poll(saved, { timeout: 10000 }).toBe(100);
  expect((await pool.query("SELECT cars_per_month FROM volume_potential_profiles WHERE customer_id = $1", [c.id])).rows[0].cars_per_month).toBe(120);

  // edit with no signal: saved on the phone, sent once back online
  await page.locator("[data-vp-edit-open]").click();
  await expect(form).toBeVisible();
  await form.locator('input[name="total_l"]').fill("150");
  await context.setOffline(true);
  await form.locator('button[type="submit"]').click();
  await expect(form).toHaveCount(0, { timeout: 10000 });
  expect(await saved()).toBe(100);
  // reopened while the change still waits: the sheet shows the waiting value, not the old one (Codex review), and Cancel keeps it
  await page.locator("[data-vp-edit-open]").click();
  await expect(form.locator('input[name="total_l"]')).toHaveValue("150");
  await page.locator("#vp-cancel").click();
  await expect(form).toHaveCount(0);
  await context.setOffline(false);
  await expect.poll(saved, { timeout: 20000 }).toBe(150);
  const hist = await pool.query("SELECT COUNT(*)::int AS n FROM volume_potential_history WHERE customer_id = $1", [c.id]);
  expect(hist.rows[0].n).toBe(2);

  // the Opportunities report lists the customer (the rep's own), with its whole potential still open
  await page.goto("/#/reports?r=volume_opportunities");
  const row = page.locator(`.opp-row[data-cid="${c.id}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText("150");
  await page.screenshot({ path: test.info().outputPath("vp-opportunities-hy.png") });
});
