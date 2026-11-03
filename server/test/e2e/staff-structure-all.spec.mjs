import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-03: every role sees the company structure (names, positions, who reports to whom) -- also a person with no Staff card.
test("Staff: a sales manager with no Staff card sees the company structure, no pay", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const stamp = Date.now();
  const { rows: [boss] } = await pool.query("INSERT INTO staff_members (name, position, kind, fixed_salary_amd) VALUES ($1, 'E2E Chief', 'director', 777777) RETURNING id", [`E2E Boss ${stamp}`]);
  const { rows: [below] } = await pool.query("INSERT INTO staff_members (name, position, kind, reports_to, fixed_salary_amd) VALUES ($1, 'E2E Clerk', 'office', $2, 555555) RETURNING id", [`E2E Clerk ${stamp}`, boss.id]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, rep.email);
    await page.goto("/#/staff");
    await expect(page.locator(".st-tree")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".st-node", { hasText: `E2E Boss ${stamp}` })).toBeVisible();
    await expect(page.locator(".st-node", { hasText: `E2E Clerk ${stamp}` })).toBeVisible();
    expect(await page.locator("#app").innerText()).not.toMatch(/777,?777|555,?555/);
  } finally {
    await pool.query("DELETE FROM staff_members WHERE id = ANY($1)", [[below.id, boss.id]]);
  }
});
