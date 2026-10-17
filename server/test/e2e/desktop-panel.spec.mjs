import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18 (desktop v3): Orders and Customers tables have sortable column headings; on a wide window an order or a
// task opens as a panel docked beside the list (not a dialog on top of it). A phone shows none of it.
test.describe("Desktop column headings and docked panel", () => {
  async function seed(fixtures) {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "Panel Rep" });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const names = ["Zeta Garage", "Alpha Garage", "Mid Garage"];
    const totals = [30000, 10000, 20000];
    const orders = [];
    for (let i = 0; i < 3; i++) {
      const c = await fixtures.createCustomer({ name: `${names[i]} ${Date.now() % 100000}`, created_by: admin.id, assigned_manager_id: rep.id });
      orders.push(await fixtures.createOrder({ customer_id: c.id, user_id: rep.id, status: "submitted", total_amd: totals[i], product, quantity: totals[i] / 10000 }));
    }
    return { admin, rep, orders };
  }

  test("Orders: clicking a heading sorts, a second click reverses; the date sort keeps day headings", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    await expect(page.locator("#orders-list > .list-row").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".desk-thead-orders")).toBeVisible();
    await expect(page.locator("#orders-list .order-date-heading").first()).toBeVisible();

    // the heading asks the server for the whole history in that order, so the list refills a moment after the click
    const amounts = () => page.locator("#orders-list > .list-row .text-amount").allTextContents().then((a) => a.map((x) => Number(x.replace(/[^\d]/g, ""))));
    const desc = (a) => a.length >= 3 && a.every((v, i) => i === 0 || a[i - 1] >= v);
    const asc = (a) => a.length >= 3 && a.every((v, i) => i === 0 || a[i - 1] <= v);
    await page.locator('.desk-sort[data-sort-key="amount"]').click();
    await expect(page.locator("#orders-list .order-date-heading")).toHaveCount(0);
    await expect.poll(async () => desc(await amounts())).toBe(true);
    await page.locator('.desk-sort[data-sort-key="amount"]').click();
    await expect.poll(async () => asc(await amounts())).toBe(true);
    await expect(page.locator('.desk-sort[data-sort-key="amount"] .desk-sort-arrow')).toHaveText("▲");

    await page.locator('.desk-sort[data-sort-key="customer"]').click();
    await expect
      .poll(async () => {
        const names = (await page.locator("#orders-list > .list-row strong").allTextContents()).filter((n) => /Garage \d+$/.test(n));
        return names.length >= 3 && names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0);
      })
      .toBe(true);

    await page.locator('.desk-sort[data-sort-key="date"]').click();
    await expect(page.locator("#orders-list .order-date-heading").first()).toBeVisible();
  });

  test("Customers: the Last visit heading uses the existing sort", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/customers");
    await expect(page.locator("#customer-list > .list-row").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".desk-thead-customers")).toBeVisible();
    await page.locator('.desk-sort[data-sort-key="last_visit"]').click();
    await expect(page.locator('.desk-sort[data-sort-key="last_visit"]')).toHaveClass(/desk-sort-on/);
    await expect(page.locator("#sort-menu [data-sort=last_visit]")).toHaveAttribute("aria-checked", "true");
  });

  test("an order opens as a docked panel beside the list; another row swaps it; X closes it", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin, orders } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    const rows = page.locator("#orders-list > .list-row");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    await rows.first().click();
    const sheet = page.locator(".sheet-overlay.sheet-docked > .sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".order-detail-customer")).toBeVisible({ timeout: 10000 });
    const box = await sheet.boundingBox();
    expect(box.x + box.width).toBeGreaterThan(1430); // docked against the right edge
    expect(box.width).toBeLessThan(600);
    // the list is still visible and its open row is marked
    await expect(page.locator("#orders-list > .list-row.row-open")).toHaveCount(1);
    const listBox = await rows.first().boundingBox();
    expect(listBox.x + listBox.width).toBeLessThan(box.x + 1);
    // another row swaps the panel (one panel only)
    await rows.nth(1).click();
    await expect(page.locator(".sheet-overlay.sheet-docked")).toHaveCount(1);
    await expect(page.locator("#orders-list > .list-row.row-open")).toHaveCount(1);
    await sheet.locator(".sheet-close-x").click();
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);
    await expect(page.locator("#orders-list > .list-row.row-open")).toHaveCount(0);
    void orders;
  });

  test("below 1400 px an order is the centred dialog again, and a phone has no headings", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const { admin } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    const rows = page.locator("#orders-list > .list-row");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    await rows.first().click();
    await expect(page.locator(".sheet-overlay")).toHaveCount(1);
    await expect(page.locator(".sheet-overlay.sheet-docked")).toHaveCount(0);
    await page.locator(".sheet-close-x").click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/customers");
    await expect(page.locator("#customer-list > .list-row").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".desk-thead-customers")).toBeHidden();
  });
});

test.describe("Activity and Tasks column headings", () => {
  test("Tasks: Person heading sorts, a second click reverses; Activity: Date heading flips newest/oldest", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const admin = await fixtures.createUser("admin");
    const repA = await fixtures.createUser("sales_manager", { name: "Aaa Rep" });
    const repZ = await fixtures.createUser("sales_manager", { name: "Zzz Rep" });
    const customer = await fixtures.createCustomer({ name: "Heading Garage", created_by: admin.id, assigned_manager_id: repA.id });
    for (const [title, rep, due] of [["Task for Z", repZ, 1], ["Task for A", repA, 2]]) {
      await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ($1, $2, $3, $4, current_date + $5::int)", [title, admin.id, rep.id, customer.id, due]);
    }
    await loginViaUi(page, admin.email);
    await page.goto("/#/tasks");
    await expect(page.locator(".desk-thead-tasks")).toBeVisible({ timeout: 10000 });
    const titles = () => page.locator("#task-list > .list-row strong").allTextContents().then((a) => a.filter((x) => /^Task for/.test(x)));
    await page.locator('.desk-sort[data-sort-key="person"]').click();
    expect(await titles()).toEqual(["Task for A", "Task for Z"]);
    await page.locator('.desk-sort[data-sort-key="person"]').click();
    expect(await titles()).toEqual(["Task for Z", "Task for A"]);
    await page.locator('.desk-sort[data-sort-key="due"]').click();
    expect(await titles()).toEqual(["Task for Z", "Task for A"]);

    await page.goto("/#/activity");
    await expect(page.locator(".desk-thead-activity")).toBeVisible({ timeout: 10000 });
    await page.locator('.desk-sort[data-sort-key="date"]').click();
    await expect(page.locator('.desk-sort[data-sort-key="date"] .desk-sort-arrow')).toHaveText("▲");
    await page.locator('.desk-sort[data-sort-key="date"]').click();
    await expect(page.locator('.desk-sort[data-sort-key="date"] .desk-sort-arrow')).toHaveText("▼");
    await page.locator('.desk-sort[data-sort-key="manager"]').click();
    await expect(page.locator('.desk-sort[data-sort-key="manager"]')).toHaveClass(/desk-sort-on/);
  });
});
