import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Staff birthdays (owner, 2026-11-03): the whole team sees "Birthday today" on Home and congratulates with one tap; the birthday person sees their own line;
// the staff card has a day + month field and no year.
const today = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const [, M, D] = today.split("-").map(Number);

test("@iphone Home shows the birthday line, one tap congratulates; the staff form has day and month", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const colleague = await fixtures.createUser("sales_manager", { name: "E2E Birthday Colleague" });
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Congratulator" });
  const { rows } = await pool.query("INSERT INTO staff_members (name, position, kind, user_id, birth_day, birth_month) VALUES ('ZZ E2E Birthday', 'Sales Manager', 'rep', $1, $2, $3) RETURNING id", [colleague.id, D, M]);
  const staffId = rows[0].id;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, rep.email);
    await page.goto("/#/dashboard");
    const card = page.locator(".birthday-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("E2E Birthday Colleague");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/birthday-home.png` });
    await card.locator("[data-wish]").click();
    await expect(card).toContainText("Congratulated");
    expect((await pool.query("SELECT count(*)::int AS n FROM staff_birthday_wishes WHERE staff_id = $1", [staffId])).rows[0].n).toBe(1);
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // the staff form
    await page.context().clearCookies();
    await loginViaUi(page, admin.email);
    await page.goto("/#/staff");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-tab="people"]').click();
    await page.locator(`[data-edit="${staffId}"]`).click();
    const day = page.locator('input[name="birth_day"]');
    await expect(day).toHaveValue(String(D));
    await expect(page.locator('select[name="birth_month"]')).toHaveValue(String(M));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/birthday-staff-form.png` });
  } finally {
    await pool.query("DELETE FROM staff_members WHERE id = $1", [staffId]);
  }
});
