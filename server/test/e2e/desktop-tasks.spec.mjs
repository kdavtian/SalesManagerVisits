import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 2: Tasks on the desktop table engine -- columns, the Type / Due filter bar, bulk reassign and
// cancel from the checkbox column (server PATCH per task), CSV export.
test("desktop Tasks: columns, due filter, bulk reassign and cancel", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "Desk Task Rep" });
  const rep2 = await fixtures.createUser("sales_manager", { name: "Desk Task Other" });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const customer = await fixtures.createCustomer({ name: `DeskTask${stamp} Shop`, created_by: admin.id, assigned_manager_id: rep.id });
  const mk = async (title, due) =>
    (await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ($1, $2, $3, $4, current_date + $5::int) RETURNING id", [title, admin.id, rep.id, customer.id, due])).rows[0].id;
  const t1 = await mk(`DeskTask${stamp} overdue`, -3);
  const t2 = await mk(`DeskTask${stamp} later`, 20);
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/tasks");
    await page.locator("#task-search").fill(`DeskTask${stamp}`);
    const rows = page.locator("#task-list > .list-row");
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    const head = page.locator(".desk-thead-tasks");
    await expect(head).toBeVisible();
    const row1 = page.locator(`#task-list > .list-row[data-task-id="${t1}"]`);
    await expect(row1.locator(".desk-cell-person")).toHaveText("Desk Task Rep");
    await expect(row1.locator(".desk-cell-customer")).toHaveText(`DeskTask${stamp} Shop`);
    await expect(row1.locator(".desk-cell-kind")).toHaveText("Given by a person");
    await expect(page.locator("#task-desk-foot .desk-foot-count")).toContainText("2");

    // Due filter: overdue leaves one row and a chip
    const bar = page.locator("#task-desk-filters");
    await bar.locator('[data-desk-filter="due"]').click();
    await page.locator('.desk-pick-menu [data-value="overdue"]').click();
    await page.locator("#task-search").fill(`DeskTask${stamp}`);
    await expect(rows).toHaveCount(1);
    await expect(bar.locator(".desk-chip")).toContainText("Overdue");
    await bar.locator("[data-desk-clear]").click();
    await page.locator("#task-search").fill(`DeskTask${stamp}`);
    await expect(rows).toHaveCount(2);

    // bulk reassign both to the other rep
    await head.locator(".desk-select-all").click();
    const bulk = page.locator("#task-bulk");
    await expect(bulk.locator(".desk-bulk-count")).toContainText("2");
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-tasks.png` });
    await bulk.locator('[data-bulk="reassign"]').click();
    const sheet = page.locator(".desk-assign-sheet");
    await sheet.locator(`input[name="person"][value="${rep2.id}"]`).check();
    await sheet.locator("[data-apply]").click();
    await expect(sheet).toHaveCount(0);
    await page.locator("#task-search").fill(`DeskTask${stamp}`);
    await expect(row1.locator(".desk-cell-person")).toHaveText("Desk Task Other", { timeout: 10000 });
    const { rows: db } = await pool.query("SELECT assignee_id FROM tasks WHERE id = ANY($1)", [[t1, t2]]);
    expect(db.every((r) => r.assignee_id === rep2.id)).toBe(true);

    // bulk cancel one (the browser confirm is accepted)
    page.once("dialog", (d) => d.accept());
    await row1.locator(".desk-check").click();
    await bulk.locator('[data-bulk="cancel"]').click();
    await expect.poll(async () => (await pool.query("SELECT status FROM tasks WHERE id = $1", [t1])).rows[0].status).toBe("cancelled");
    await page.locator("#task-search").fill(`DeskTask${stamp}`);
    await expect(rows).toHaveCount(1, { timeout: 10000 });

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#task-desk-foot [data-desk-export]").click()]);
    expect(download.suggestedFilename()).toMatch(/^tasks-/);
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = ANY($1)", [[t1, t2]]);
  }
});
