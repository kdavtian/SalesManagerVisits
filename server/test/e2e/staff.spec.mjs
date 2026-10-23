import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-23: the Staff module -- payroll of a month, a person's day calendar (the boss marks days), premiums, the structure tree.
// Real staff rows may exist, so the test only creates and removes rows with the E2E position prefix.
test.use({ viewport: { width: 440, height: 956 } });
test.describe.configure({ mode: "serial" });
const SHOTS = process.env.STAFF_SHOTS;
const month = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();

let bossId, repId;
test.beforeAll(async () => {
  await pool.query("DELETE FROM staff_members WHERE position LIKE 'E2E %'");
});
test.afterAll(async () => {
  await pool.query("DELETE FROM staff_members WHERE position LIKE 'E2E %'");
});

test("admin: payroll list, structure tree, mark a day, add a premium; the rep sees only their own pay", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const dir = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const { rows: [boss] } = await pool.query(
    "INSERT INTO staff_members (name, position, kind, fixed_salary_amd, user_id) VALUES ('E2E Director Anna', 'E2E Sales Director', 'director', 300000, $1) RETURNING id", [dir.id]);
  const { rows: [r] } = await pool.query(
    `INSERT INTO staff_members (name, position, kind, reports_to, fixed_salary_amd, visit_based, user_id)
     VALUES ('E2E Rep Aram', 'E2E SM YVN', 'rep', $1, 200000, true, $2) RETURNING id`, [boss.id, rep.id]);
  bossId = boss.id;
  repId = r.id;

  await page.setViewportSize({ width: 440, height: 956 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/staff");
  await expect(page.locator(".st-row", { hasText: "E2E Rep Aram" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".st-row", { hasText: "E2E Director Anna" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/payroll.png` });

  // structure: the rep hangs under the director
  await page.locator('[data-tab="tree"]').click();
  const tree = page.locator(".st-tree");
  await expect(tree.locator("li", { hasText: "E2E Director Anna" }).locator("ul .st-node", { hasText: "E2E Rep Aram" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree.png` });

  if (SHOTS) {
    await page.locator('[data-tab="people"]').click();
    await page.locator("[data-edit]", { hasText: "E2E Rep Aram" }).click();
    await expect(page.locator("#st-form")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/edit.png` });
    await page.locator("#st-cancel").click();
    await page.locator('[data-tab="rules"]').click();
    await expect(page.locator("#st-min-visit")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/rules.png` });
    await page.locator('[data-tab="pay"]').click();
  }
  // the rep's month
  await page.locator('[data-tab="pay"]').click();
  await page.locator(".st-row", { hasText: "E2E Rep Aram" }).click();
  await expect(page.locator("h1", { hasText: "E2E Rep Aram" })).toBeVisible();
  await expect(page.locator(".st-cal")).toBeVisible();
  // mark the first working day as completed
  const firstWorking = page.locator(".st-day:not(.st-day-none):not(.st-day-blank)").first();
  const dayAttr = await firstWorking.getAttribute("data-day");
  await firstWorking.click();
  await page.locator('[data-status="completed"]').click();
  await expect(page.locator(`.st-day[data-day="${dayAttr}"]`)).toHaveClass(/st-day-ok/);
  if (SHOTS) {
    await page.locator(".st-day[data-state='unpaid']").first().click();
    await expect(page.locator("#st-day-close")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/day-sheet.png` });
    await page.locator("#st-day-close").click();
  }

  // a premium
  await page.locator("#st-add-item").click();
  await page.locator('#st-item-form [name="kind"]').selectOption("premium");
  await page.locator('#st-item-form [name="amount"]').fill("25000");
  await page.locator('#st-item-form button[type="submit"]').click();
  await expect(page.locator("#st-items")).toContainText("25,000");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/person.png`, fullPage: true });
    await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await page.goto("/#/dashboard");
    await page.goto(`/#/staff/${repId}`);
    await expect(page.locator(".st-cal")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/person-hy.png`, fullPage: true });
    await page.locator(".st-day[data-state='unpaid']").first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/day-sheet-hy.png` });
    await page.locator("#st-day-close").click();
    await page.locator("#st-back").click();
    await expect(page.locator(".st-row").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/payroll-hy.png` });
    await page.locator('[data-tab="people"]').click();
    await page.locator("[data-edit]", { hasText: "E2E Rep Aram" }).click();
    await page.waitForTimeout(500);
    await page.locator("#st-form").evaluate((el) => el.closest(".sheet").scrollTo(0, 99999));
    await page.screenshot({ path: `${SHOTS}/edit-hy-bottom.png` });
    await page.locator("#st-cancel").click();
    await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "en"));
    await page.goto("/#/dashboard");
    await page.goto("/#/staff");
  }
  const { rows: [item] } = await pool.query("SELECT amount_amd::float8 AS a FROM staff_pay_items WHERE staff_id = $1", [repId]);
  expect(item.a).toBe(25000);
  const { rows: [mark] } = await pool.query("SELECT status FROM staff_days WHERE staff_id = $1 AND day = $2", [repId, dayAttr]);
  expect(mark.status).toBe("completed");

  // the rep: only their own, and cannot mark days
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await loginViaUi(page, rep.email);
  await page.goto("/#/staff");
  await expect(page.locator(".st-row")).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator(".st-row")).toContainText("E2E Rep Aram");
  await page.locator(".st-row").click();
  await expect(page.locator(".st-cal")).toBeVisible();
  await page.locator(".st-day[data-state='paid'], .st-day[data-state='unpaid'], .st-day[data-state='future']").first().click();
  await expect(page.locator('[data-status="completed"]')).toHaveCount(0);
  void month;
  void bossId;
});
