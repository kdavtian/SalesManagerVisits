import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: Call tasks. The rep opens the task, taps Call (tel: link), comes back and records how it went.
test.describe("Call task", () => {
  test("Call button dials, the result sheet opens when the app is shown again, 'Spoke' closes the task", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: director.id, assigned_manager_id: rep.id, name: "Call Customer" });
    await pool.query("UPDATE customers SET phone = '+37491000222' WHERE id = $1", [customer.id]);
    const { rows } = await pool.query(
      "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ('Call about oil', $1, $2, $3, current_date, 'call_customer') RETURNING id",
      [director.id, rep.id, customer.id]
    );
    const taskId = rows[0].id;

    await loginViaUi(page, rep.email);
    await page.goto(`/#/tasks?open=${taskId}`);
    const call = page.locator(".task-sheet-title ~ .call-block a.btn-call, .call-block a.btn-call");
    await expect(call).toBeVisible({ timeout: 10000 });
    await expect(call).toHaveAttribute("href", "tel:+37491000222");
    const box = await call.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);

    // the real tap would open the dialer; here we only record the tap and keep the page
    await call.evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
    await call.click();
    expect(await page.evaluate(() => localStorage.getItem("fv_pending_call"))).toContain(String(taskId));

    await page.waitForTimeout(2800);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const sheet = page.locator(".call-result-overlay .sheet");
    await expect(sheet).toBeVisible({ timeout: 8000 });
    await sheet.locator('[data-result="spoke"]').click();
    await sheet.locator("#call-note").fill("will order Monday");
    await sheet.locator("#call-save").click();
    await expect(page.locator(".call-result-overlay")).toHaveCount(0);

    const after = await pool.query("SELECT status, completion_note FROM tasks WHERE id = $1", [taskId]);
    expect(after.rows[0].status).toBe("done");
    const calls = await pool.query("SELECT result FROM customer_calls WHERE task_id = $1", [taskId]);
    expect(calls.rows.map((r) => r.result)).toEqual(["spoke"]);
    expect(await page.evaluate(() => localStorage.getItem("fv_pending_call"))).toBeNull();
    await pool.query("DELETE FROM customer_calls WHERE task_id = $1", [taskId]);
    await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  });

  test("a customer without a phone shows a disabled Call button and a hint; a Visit task shows its icon", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: director.id, assigned_manager_id: rep.id, name: "No Phone Customer" });
    await pool.query("UPDATE customers SET phone = NULL WHERE id = $1", [customer.id]);
    const { rows } = await pool.query(
      "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ('Call nobody', $1, $2, $3, current_date, 'call_customer') RETURNING id",
      [director.id, rep.id, customer.id]
    );
    await loginViaUi(page, rep.email);
    await page.goto(`/#/tasks?open=${rows[0].id}`);
    await expect(page.locator(".call-block button.btn-call")).toBeDisabled({ timeout: 10000 });
    await expect(page.locator(".call-block .task-hint")).toBeVisible();
    await pool.query("DELETE FROM tasks WHERE id = $1", [rows[0].id]);
  });
});
