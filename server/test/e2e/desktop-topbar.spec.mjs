import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 4: on a desktop window the top bar has a global search (customers, orders, tasks; "/" focuses
// it, arrows + Enter open a result) and quick actions (New order "n o", New task "n t", New customer "n c"); Esc closes the
// top-most sheet or docked panel wherever the focus is. A phone has none of it.
test("desktop top bar: global search, quick actions, shortcuts, Esc", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "Topbar Rep" });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const customer = await fixtures.createCustomer({ name: `Topbar${stamp} Shop`, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `TBC${stamp}` });
  const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 33000, order_code: `ZQ${stamp}` });
  const task = (
    await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ($1, $2, $3, $4, current_date + 1) RETURNING id", [`Callback ${stamp}`, admin.id, rep.id, customer.id])
  ).rows[0].id;
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/activity");
    const input = page.locator("#topbar-search-input");
    await expect(input).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.topbar-action[data-quick="order"]')).toBeVisible();
    await expect(page.locator('.topbar-action[data-quick="task"]')).toBeVisible();
    await expect(page.locator('.topbar-action[data-quick="customer"]')).toBeVisible();

    // "/" focuses the search; a customer name finds the customer, its order (by customer name) and its task
    await page.locator("h1").first().click();
    await page.keyboard.press("/");
    await expect(input).toBeFocused();
    await input.fill(`Topbar${stamp}`);
    const results = page.locator("#topbar-search-results");
    // grouped: the customer, its order and its task (both name the shop in their second line)
    await expect(results.locator(".topbar-search-main", { hasText: `Topbar${stamp} Shop` })).toBeVisible({ timeout: 10000 });
    await expect(results.locator(".topbar-search-main", { hasText: `ZQ${stamp}` })).toBeVisible();
    await expect(results.locator(".topbar-search-main", { hasText: `Callback ${stamp}` })).toBeVisible();
    await expect(results.locator(".topbar-search-heading")).toHaveText(["Customers", "Orders", "Tasks"]);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-topbar-search.png` });
    // Enter opens the first result (the customer)
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#/customers/${customer.id}$`));

    // an order code: arrows + Enter open the order
    await input.fill(`ZQ${stamp}`);
    await expect(results.locator(".topbar-search-main", { hasText: `ZQ${stamp}` })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#/orders\\?open=${order.id}$`));
    await expect(page.locator(".sheet-overlay .order-detail-customer")).toBeVisible({ timeout: 10000 });

    // Esc closes the docked order even when the focus is on the page, not in the panel
    await page.locator("h1").first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);

    // a task by its title
    await input.fill(`Callback ${stamp}`);
    await results.locator(".topbar-search-item", { has: page.locator(".topbar-search-main", { hasText: `Callback ${stamp}` }) }).click();
    await expect(page).toHaveURL(new RegExp(`#/tasks\\?open=${task}$`));
    await expect(page.locator(".sheet-overlay .sheet")).toContainText(`Callback ${stamp}`, { timeout: 10000 });
    await page.locator("h1").first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);

    // nothing found
    await input.fill(`nothing-${stamp}-xyz`);
    await expect(results).toContainText("Nothing found", { timeout: 10000 });
    await input.press("Escape");
    await input.press("Escape");
    await expect(input).not.toBeFocused();

    // n o: New order = the customer picker on the Orders page; Esc closes it
    await page.locator("h1").first().click();
    await page.keyboard.press("n");
    await page.keyboard.press("o");
    await expect(page).toHaveURL(/#\/orders\?new=1$/);
    await expect(page.locator("#order-customer-search")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#order-customer-search")).toHaveCount(0);

    // n t: the task editor
    await page.locator("h1").first().click();
    await page.keyboard.press("n");
    await page.keyboard.press("t");
    await expect(page.locator(".sheet-overlay .sheet").first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);

    // n c: add a customer on the map
    await page.locator("h1").first().click();
    await page.keyboard.press("n");
    await page.keyboard.press("c");
    await expect(page).toHaveURL(/#\/map\?add=1$/);

    // phone: no search, no quick actions
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/activity");
    await page.reload();
    await expect(page.locator("#top-bar")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".topbar-search")).toHaveCount(0);
    await expect(page.locator(".topbar-actions")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = $1", [task]);
  }
});
