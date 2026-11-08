import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-16: long tap on the New task icon offers New task / Collect debt / Make order / Check products, and the
// same four are choosable inside the editor. Typed tasks pre-fill the title and checklist and need a customer.
test.describe("Typed tasks", () => {
  test("long press on + opens the type menu; a typed task is pre-filled, needs a customer and is saved with its type", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Typed Task Garage", assigned_manager_id: rep.id, sales_channel: "SM YVN", erp_customer_id: `E2E-TT-${Date.now()}` });

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

// Owner, 2026-11-08: order tasks close only by an order (or a visit saying why there was none): the rep sees why there is no Done button.
test("a Make order task and the automatic 'stopped ordering' task show the 'closes by itself' hint and no Mark complete button", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Order Lock Garage", assigned_manager_id: rep.id, sales_channel: "SM YVN" });
  const ids = [];
  for (const [title, kind, auto] of [["Make order lock", "make_order", null], ["Stopped ordering lock", null, "reorder_followup"]]) {
    ids.push((await pool.query(
      "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind, auto_kind) VALUES ($1, $2, $3, $4, current_date + 2, $5, $6) RETURNING id",
      [title, director.id, rep.id, customer.id, kind, auto]
    )).rows[0].id);
  }
  try {
    await loginViaUi(page, rep.email);
    for (const [i, title] of ["Make order lock", "Stopped ordering lock"].entries()) {
      await page.goto(`/#/tasks?open=${ids[i]}`);
      await expect(page.locator(".task-sheet-title")).toContainText(title, { timeout: 15000 });
      await expect(page.locator("#task-selfclose-hint")).toContainText("order");
      await expect(page.locator('[data-action="complete"]')).toHaveCount(0);
      await expect(page.locator('[data-action="order-usual"]')).toBeVisible(); // the way to do the work is still one tap away
      await page.keyboard.press("Escape");
    }
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = ANY($1)", [ids]);
  }
});

// A person's "Make order" task gets the "why no order" question at the check-in too, and the reason closes it through the server.
test("check-in with a Make order task open: the 'why no order' sheet appears and the reason closes the task", async ({ page, context, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Why No Order Garage", assigned_manager_id: rep.id, sales_channel: "SM YVN", lat: 40.18, lng: 44.51 });
  const task = (await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ('Make order why-no-order', $1, $2, $3, current_date + 1, 'make_order') RETURNING id",
    [director.id, rep.id, customer.id]
  )).rows[0].id;
  try {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 40.18, longitude: 44.51 });
    await loginViaUi(page, rep.email);
    await page.goto(`/#/checkin/${customer.id}`);
    await expect(page.locator("#verify-banner")).toContainText(/±/, { timeout: 15000 });
    await expect(page.locator("#checkin-tasks")).toContainText("Make order why-no-order", { timeout: 10000 });
    await page.locator('label.outcome-chip:has(input[value="follow_up_required"])').click();
    await page.locator("#checkin-submit").click();
    await expect(page.locator("#order-task-make")).toBeVisible(); // the question
    await page.locator('[data-reason="no_money"]').click();
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/checkins") && res.request().method() === "POST"),
      page.locator("#order-task-skip").click(),
    ]);
    expect(response.ok()).toBeTruthy();
    fixtures.trackRow("checkins", (await response.json()).id);
    await expect.poll(async () => (await pool.query("SELECT status FROM tasks WHERE id = $1", [task])).rows[0].status, { timeout: 8000 }).toBe("done");
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = $1", [task]);
  }
});
