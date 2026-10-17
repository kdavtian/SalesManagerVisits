import { test, expect, loginViaUi } from "./fixtures.mjs";

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

    const amounts = () => page.locator("#orders-list > .list-row .text-amount").allTextContents().then((a) => a.map((x) => Number(x.replace(/[^\d]/g, ""))));
    await page.locator('.desk-sort[data-sort-key="amount"]').click();
    await expect(page.locator("#orders-list .order-date-heading")).toHaveCount(0);
    let list = (await amounts()).slice(0, 3);
    expect(list).toEqual([...list].sort((a, b) => b - a));
    await page.locator('.desk-sort[data-sort-key="amount"]').click();
    list = (await amounts()).slice(0, 3);
    expect(list).toEqual([...list].sort((a, b) => a - b));
    await expect(page.locator('.desk-sort[data-sort-key="amount"] .desk-sort-arrow')).toHaveText("▲");

    await page.locator('.desk-sort[data-sort-key="customer"]').click();
    const names = await page.locator("#orders-list > .list-row strong").allTextContents();
    const mine = names.filter((n) => /Garage \d+$/.test(n));
    expect(mine).toEqual([...mine].sort((a, b) => a.localeCompare(b)));

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
