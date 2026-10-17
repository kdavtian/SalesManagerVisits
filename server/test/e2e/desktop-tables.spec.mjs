import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: the desktop version was "just a copy of the mobile one". From 1024 px the sidebar is compact (Tasks is a
// main item, no second logo in the top bar), Orders / Activity / Customers / Tasks are tables (one slim row per item) and the
// customer page has two columns. A phone must stay exactly as it was.
test.describe("Desktop tables and sidebar", () => {
  async function seed(fixtures) {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "Desk Rep" });
    const product = await fixtures.createProduct({ unit_price_amd: 12000 });
    const customers = [];
    for (let i = 0; i < 6; i++) {
      const c = await fixtures.createCustomer({ name: `Desk Customer ${i}`, created_by: admin.id, assigned_manager_id: rep.id });
      customers.push(c);
      await fixtures.createOrder({ customer_id: c.id, user_id: rep.id, status: "submitted", total_amd: 24000 + i * 1000, product, quantity: 2 });
    }
    const taskIds = [];
    for (let i = 0; i < 4; i++) {
      const { rows } = await pool.query(
        "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ($1, $2, $3, $4, current_date + $5::int) RETURNING id",
        [`Desk task ${i}`, admin.id, rep.id, customers[i].id, i - 1]
      );
      taskIds.push(rows[0].id);
    }
    return { admin, rep, customers, taskIds };
  }

  test("sidebar is compact with Tasks as a main item, and Orders / Tasks / Customers are slim table rows", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin, taskIds } = await seed(fixtures);
    await loginViaUi(page, admin.email);

    // Sidebar: Tasks is in the main group; the top bar carries no second logo; the whole menu fits a 900 px window.
    await expect(page.locator('#sidebar .sidebar-item[data-hash="#/tasks"]')).toBeVisible();
    await expect(page.locator("#top-bar .topbar-brand")).toBeHidden();
    const fits = await page.locator("#sidebar").evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    expect(fits).toBe(true);

    // Orders: slim rows, several visible at once, columns laid out as a grid.
    await page.goto("/#/orders");
    const orderRows = page.locator("#orders-list > .list-row");
    await expect(orderRows.first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(400);
    const first = await orderRows.first().boundingBox();
    expect(first.height).toBeLessThan(80);
    expect(await orderRows.first().evaluate((el) => getComputedStyle(el).display)).toBe("grid");
    const visibleRows = await orderRows.evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().bottom < innerHeight).length);
    expect(visibleRows).toBeGreaterThanOrEqual(4);
    // the amount sits at the right end of the row, the customer name at the left
    const nameBox = await orderRows.first().locator("strong").boundingBox();
    const amountBox = await orderRows.first().locator(".text-amount").boundingBox();
    expect(amountBox.x).toBeGreaterThan(nameBox.x + 400);

    // Tasks and Customers are slim rows too; the list sits inside the page (not flush against the sidebar).
    await page.goto("/#/tasks");
    await page.locator("#task-list > .list-row").first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    const taskRow = await page.locator("#task-list > .list-row").first().boundingBox();
    expect(taskRow.height).toBeLessThan(80);
    expect(taskRow.x).toBeGreaterThanOrEqual(248 + 12);
    await page.locator(`#task-list [data-task-id="${taskIds[0]}"]`).click();
    await expect(page.locator(".sheet-overlay .sheet").first()).toBeVisible();
    await page.locator(".sheet-close-x").click();

    await page.goto("/#/customers");
    const custRows = page.locator("#customer-list > .list-row");
    await expect(custRows.first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(400);
    const custBox = await custRows.first().boundingBox();
    expect(custBox.height).toBeLessThan(80);
    expect(custBox.x).toBeGreaterThanOrEqual(248 + 12);
    // one column of rows, not a grid of cards
    const second = await custRows.nth(1).boundingBox();
    expect(Math.abs(second.x - custBox.x)).toBeLessThan(2);
  });

  test("customer page has two columns on a desktop window and one on a phone", async ({ page, fixtures }) => {
    const { admin, customers } = await seed(fixtures);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customers[0].id}`);
    await expect(page.locator(".cd-col-main #checkin-btn")).toBeVisible({ timeout: 10000 });
    const left = await page.locator(".cd-col-main #checkin-btn").boundingBox();
    const right = await page.locator(".cd-col-side #checkin-history, .cd-col-side #visit-history-anchor").first().boundingBox();
    expect(right.x).toBeGreaterThan(left.x + 300);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await page.locator(".cd-col-main").evaluate((el) => getComputedStyle(el).display)).toBe("contents");
    const phoneLeft = await page.locator("#checkin-btn").boundingBox();
    const phoneHist = await page.locator("#visit-history-anchor").boundingBox();
    // one column: the history heading lies below the actions, at the same left edge
    expect(phoneHist.y).toBeGreaterThan(phoneLeft.y);
    expect(Math.abs(phoneHist.x - 16)).toBeLessThan(6);
  });

  test("on a phone the lists keep their card layout", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { admin } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    const row = page.locator("#orders-list > .list-row").first();
    await expect(row).toBeVisible({ timeout: 10000 });
    expect(await row.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
    await expect(page.locator("#nav-bar")).toBeVisible();
    await expect(page.locator("#sidebar")).toBeHidden();
  });
});
