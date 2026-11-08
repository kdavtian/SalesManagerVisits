import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-08: a "well done" moment when a task is finished, also when the system finished it (payment / order / visit / check).
// The card is shown once, never blocks the screen, and calms down for reduced motion.
async function seed(fixtures, { hy = false } = {}) {
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Reward Garage", assigned_manager_id: rep.id, sales_channel: "SM YVN" });
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind, status, completed_at, completed_by, outcome)
     VALUES ('Collect from Reward Garage', $1, $2, $3, current_date, 'collect_debt', 'done', now(), $2, 'paid') RETURNING id`,
    [director.id, rep.id, customer.id]
  );
  return { rep, taskId: rows[0].id, hy };
}

test.describe("Task reward", () => {
  test("a task the system finished is celebrated once, on a phone in Armenian, without covering the screen", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const { rep, taskId } = await seed(fixtures);
    await loginViaUi(page, rep.email);
    const card = page.locator(".task-reward");
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator(".reward-title")).not.toHaveText("");
    await expect(card).toContainText("Reward Garage");
    await page.waitForTimeout(600); // the card is still scaling in for a moment
    // fits a 320 px phone and keeps a 44 px close target
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    const close = await card.locator(".reward-close").boundingBox();
    expect(close.width).toBeGreaterThanOrEqual(44);
    expect(close.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    // the server remembers it was shown
    await expect.poll(async () => (await pool.query("SELECT reward_seen_at FROM tasks WHERE id = $1", [taskId])).rows[0].reward_seen_at).not.toBeNull();
    await card.locator(".reward-close").click();
    await expect(card).toHaveCount(0);
    // a reload does not show it again
    await page.reload();
    await page.waitForTimeout(4500);
    await expect(page.locator(".task-reward")).toHaveCount(0);
  });

  test("reduced motion: the card shows without confetti or movement", async ({ page, fixtures }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    const { rep } = await seed(fixtures);
    await loginViaUi(page, rep.email);
    const card = page.locator(".task-reward");
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator(".reward-confetti i")).toHaveCount(0);
    expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("finishing a task by hand celebrates it on the spot", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, due_date) VALUES ('Plain job by hand', $1, $2, current_date)", [director.id, rep.id]);
    await loginViaUi(page, rep.email);
    await page.goto("/#/tasks");
    await page.getByText("Plain job by hand").first().click();
    await page.locator('[data-action="complete"]').click();
    await expect(page.locator(".task-reward")).toBeVisible({ timeout: 10000 });
  });
});
