import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-05: a visit / check-products / collect-debt task has no "Done" button; the rep sees why, a debt task has "Record result",
// management can cancel with a reason.
test("self-closing tasks: no Done button, a hint, Record result on a debt task, a reason to cancel", async ({ page, fixtures }) => {
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: director.id, assigned_manager_id: rep.id, name: "E2E Lock Shop", sales_channel: "SM YVN" });
  const mk = async (kind) =>
    (await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ($1, $2, $3, $4, current_date, $5) RETURNING id", [`E2E ${kind}`, director.id, rep.id, customer.id, kind])).rows[0].id;
  const visit = await mk("visit_customer");
  const debt = await mk("collect_debt");
  const plain = (await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, due_date) VALUES ('E2E plain task', $1, $2, current_date) RETURNING id", [director.id, rep.id])).rows[0].id;
  await page.setViewportSize({ width: 390, height: 844 });

  await loginViaUi(page, rep.email);
  await page.goto(`/#/tasks?open=${visit}`);
  await expect(page.locator("#task-selfclose-hint")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-action="complete"]')).toHaveCount(0);
  await expect(page.locator('[data-action="cancel"]')).toHaveCount(0); // a rep cannot cancel it either
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/task-visit-rep.png" });

  await page.goto(`/#/tasks?open=${debt}`);
  await page.reload();
  await expect(page.locator('[data-action="record-result"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-action="complete"]')).toHaveCount(0);
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/task-debt-rep.png" });

  await page.goto(`/#/tasks?open=${plain}`);
  await page.reload();
  await expect(page.locator('[data-action="complete"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#task-selfclose-hint")).toHaveCount(0);

  // management: cancel needs a reason
  await page.context().clearCookies();
  await loginViaUi(page, director.email);
  await page.goto(`/#/tasks?open=${visit}`);
  await page.reload();
  await expect(page.locator("#task-cancel-reason")).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/task-visit-director.png" });
  await page.locator('[data-action="cancel"]').click();
  await expect(page.locator("#task-sheet-error")).toBeVisible();
  await page.locator("#task-cancel-reason").fill("The shop closed down");
  await page.locator('[data-action="cancel"]').click();
  await expect(page.locator(".badge", { hasText: /cancel/i }).first()).toBeVisible({ timeout: 10000 });
});
