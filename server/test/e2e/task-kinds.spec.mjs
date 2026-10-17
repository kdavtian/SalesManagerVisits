import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-16: long tap on the New task icon offers New task / Collect debt / Make order / Check products, and the
// same four are choosable inside the editor. Typed tasks pre-fill the title and checklist and need a customer.
test.describe("Typed tasks", () => {
  test("long press on + opens the type menu; a typed task is pre-filled, needs a customer and is saved with its type", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Typed Task Garage", assigned_manager_id: rep.id, sales_channel: "SM YVN" });

    await loginViaUi(page, director.email);
    await page.goto("/#/tasks");
    const plus = page.locator("#task-new-btn");
    await expect(plus).toBeVisible();

    // a plain tap still opens the plain editor straight away
    await plus.click();
    await expect(page.locator(".task-editor")).toBeVisible();
    await expect(page.locator("#task-title-input")).toHaveValue("");
    await page.locator(".task-editor [data-action=close]").first().click();

    // a long press opens the menu with the six choices
    const box = await plus.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const options = page.locator(".om-sheet .om-option");
    await expect(options).toHaveCount(6); // plain, Collect debt, Make order, Check products, Call, Visit
    await options.nth(1).click(); // Collect debt

    await expect(page.locator(".task-editor")).toBeVisible();
    const titleInput = page.locator("#task-title-input");
    await expect(titleInput).not.toHaveValue("");
    const collectTitle = await titleInput.inputValue();
    await expect(page.locator("#task-items input[data-idx]").first()).not.toHaveValue("");

    // switching the type inside the editor swaps the untouched pre-fill
    await page.locator('#task-type-row [data-type="make_order"]').click();
    await expect(titleInput).not.toHaveValue(collectTitle);

    // no customer yet -> blocked
    await page.locator("#task-assignee").selectOption(String(rep.id));
    await page.locator("#task-save").click();
    await expect(page.locator("#task-form-error")).toBeVisible();

    await page.locator("#task-customer-search").fill("Typed Task");
    await page.locator("#task-customer-results [data-cid]").first().click();
    await page.locator("#task-save").click();
    await expect(page.locator(".task-editor")).toHaveCount(0, { timeout: 10000 });

    const { rows } = await pool.query("SELECT task_kind, customer_id FROM tasks WHERE assignee_id = $1", [rep.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_kind).toBe("make_order");
    expect(rows[0].customer_id).toBe(customer.id);
  });
});
