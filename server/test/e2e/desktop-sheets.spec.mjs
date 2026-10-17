import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: on a desktop window a bottom sheet hung at the bottom edge (cut off under the Dock). From 900 px
// every sheet is a centred dialog; a finished task shows Close next to Reopen/Edit; Activity's person pills are wider.
test.describe("Desktop sheets and wide pills", () => {
  test("a task sheet is a centred dialog on a desktop window and a done task has Reopen/Edit and no extra Close button", async ({ page, fixtures }) => {
    // 1100 px: wide enough for the desktop layout, below the 1400 px where tasks open as a docked panel (desktop-panel.spec.mjs)
    await page.setViewportSize({ width: 1100, height: 900 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const { rows } = await pool.query(
      "INSERT INTO tasks (title, creator_id, assignee_id, due_date, status, completed_at, completed_by) VALUES ('Done task', $1, $2, current_date, 'done', now(), $2) RETURNING id",
      [admin.id, rep.id]
    );
    await loginViaUi(page, admin.email);
    await page.goto(`/#/tasks?open=${rows[0].id}`);
    const sheet = page.locator(".sheet-overlay .sheet").first();
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
    const box = await sheet.boundingBox();
    expect(box.y).toBeGreaterThan(20);
    expect(box.y + box.height).toBeLessThan(900 - 20);
    expect(box.width).toBeLessThanOrEqual(561);
    const radius = await sheet.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius);
    expect(parseFloat(radius)).toBeGreaterThan(4);
    const actions = sheet.locator("#task-sheet-actions");
    await expect(actions.locator('[data-action="reopen"]')).toBeVisible();
    await expect(actions.locator('[data-action="edit"]')).toBeVisible();
    // no Close button in the action row (the X in the corner closes the sheet)
    await expect(actions.locator('[data-action="close"]')).toHaveCount(0);
    await sheet.locator(".sheet-close-x").click();
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);
    await pool.query("DELETE FROM tasks WHERE id = $1", [rows[0].id]);
  });

  test("on a phone the sheet stays a bottom sheet", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const { rows } = await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, due_date) VALUES ('Phone task', $1, $2, current_date) RETURNING id", [admin.id, rep.id]);
    await loginViaUi(page, admin.email);
    await page.goto(`/#/tasks?open=${rows[0].id}`);
    const sheet = page.locator(".sheet-overlay .sheet").first();
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
    const box = await sheet.boundingBox();
    expect(box.y + box.height).toBeGreaterThan(844 - 4);
    await pool.query("DELETE FROM tasks WHERE id = $1", [rows[0].id]);
  });

  test("Activity person pills are not narrow", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await fixtures.createUser("sales_manager");
    await loginViaUi(page, admin.email);
    await page.goto("/#/activity");
    const pills = page.locator("#activity-manager-bar .stat-pill");
    await expect(pills.first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1200);
    const widths = await pills.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(116);
  });
});
