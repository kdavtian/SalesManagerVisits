import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-27: "Specific date" opens the calendar at once; the date sits left-aligned in its box; checklist items one by one;
// the accountant / financial director sends a REQUEST (Խնդրանք) to the sales director.
test("new task: the date wheel opens at once, checklist items one by one", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, director.email);
  await page.goto("/#/tasks");
  await page.locator("#task-new-btn").click();
  await expect(page.locator(".task-editor")).toBeVisible();

  // one tap on "Specific date" -> the wheel picker, Done -> the date is in the box
  await page.locator('.task-editor [data-mode="date"]').click();
  await expect(page.locator(".wheel-date-picker")).toBeVisible();
  if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/task-date-wheel.png` });
  await page.locator("[data-date-done]").click();
  await expect(page.locator(".wheel-date-picker")).toHaveCount(0);
  await expect(page.locator("#task-due-text")).toHaveText(/^\d{2}-\d{2}-\d{4}$/);
  await expect(page.locator('.task-editor [data-mode="date"]')).toHaveAttribute("aria-pressed", "true");

  // checklist: + is off until the item has text
  const add = page.locator("#task-items [data-add]");
  await expect(add).toBeDisabled();
  await page.locator('#task-items input[data-idx="0"]').fill("First");
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.locator("#task-items input[data-idx]")).toHaveCount(2);
  await expect(page.locator("#task-items [data-add]")).toBeDisabled();
  await page.locator('#task-items input[data-idx="1"]').fill("Second");
  await page.locator('#task-items input[data-idx="1"]').press("Enter"); // Enter adds the next one
  await expect(page.locator("#task-items input[data-idx]")).toHaveCount(3);
  if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/task-editor.png` });

  await page.locator("#task-title-input").fill("ITest one by one");
  await page.locator("#task-assignee").selectOption(String(rep.id));
  await page.locator("#task-save").click();
  await expect(page.locator(".task-editor")).toHaveCount(0, { timeout: 10000 });
  const { rows } = await pool.query("SELECT (SELECT count(*)::int FROM task_items i WHERE i.task_id = t.id) AS n FROM tasks t WHERE t.assignee_id = $1", [rep.id]);
  expect(rows[0].n).toBe(2); // the empty third row is not saved
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [rep.id]);
});

test("the accountant sends a Request to the sales director", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const accountant = await fixtures.createUser("accountant");
  const director = await fixtures.createUser("sales_director");
  await loginViaUi(page, accountant.email);
  await page.goto("/#/tasks");
  await page.locator("#task-new-btn").click();
  await expect(page.locator(".task-editor h2")).toHaveText("New request");
  const people = await page.locator("#task-assignee option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  expect(people).toContain(String(director.id));
  await page.locator("#task-title-input").fill("ITest request");
  await page.locator("#task-assignee").selectOption(String(director.id));
  await page.locator("#task-save").click();
  await expect(page.locator(".task-editor")).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".task-card", { hasText: "ITest request" }).locator(".badge-info")).toHaveText("Request");
  const { rows } = await pool.query("SELECT is_request FROM tasks WHERE assignee_id = $1", [director.id]);
  expect(rows[0].is_request).toBe(true);
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [director.id]);
});
