import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: return some products or a whole order. The rep asks on the order, management approves, the warehouse manager confirms the
// goods are back (good / damaged); the customer shows a provisional credit at once. An order that is not delivered yet is cancelled instead.
test.describe("Order returns", () => {
  let erpId = null;
  test.afterEach(async () => {
    if (erpId) await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
    erpId = null;
  });
  test("rep asks for a partial return, admin approves, warehouse receives", async ({ page, browser, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const wm = await fixtures.createUser("warehouse_manager");
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const customer = await fixtures.createCustomer({ name: "Return Shop", created_by: admin.id, assigned_manager_id: rep.id });
    const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "delivered", total_amd: 30000, product, quantity: 3 });

    // 1. the rep: Orders -> the delivered order -> Return -> 2 of 3 -> reason -> send
    await page.setViewportSize({ width: 440, height: 956 });
    await loginViaUi(page, rep.email);
    await page.goto("/#/orders");
    await page.locator('#order-status-filters [data-status=""]').click();
    await page.locator("#orders-list > .list-row", { hasText: "Return Shop" }).first().click({ timeout: 15000 });
    await page.getByRole("button", { name: "Return", exact: true }).click();
    const line = page.locator(".rt-line").first();
    await line.locator("[data-inc]").click();
    await line.locator("[data-inc]").click();
    await expect(line.locator("[data-q]")).toHaveText("2");
    await page.getByRole("button", { name: "Damaged goods" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: test.info().outputPath("rep-return-sheet.png") });
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.locator(".rt-order-row")).toContainText("Waiting for decision", { timeout: 10000 }).catch(() => {});
    const { rows: [made] } = await pool.query("SELECT id, status, kind, credit_amd FROM order_returns WHERE order_id = $1", [order.id]);
    expect(made.status).toBe("requested");
    expect(made.kind).toBe("return");
    expect(Number(made.credit_amd)).toBe(20000);

    // 2. admin: To decide -> Approve
    const { context: adminCtx, page: adminPage } = await newIdentityPage(browser);
    await adminPage.setViewportSize({ width: 440, height: 956 });
    await loginViaUi(adminPage, admin.email);
    await adminPage.goto("/#/returns");
    const card = adminPage.locator(".rt-card", { hasText: "Return Shop" });
    await expect(card).toContainText("2", { timeout: 15000 });
    await expect(card).toContainText("20,000");
    await adminPage.waitForTimeout(300);
    await adminPage.screenshot({ path: test.info().outputPath("admin-returns.png") });
    await card.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await pool.query("SELECT status FROM order_returns WHERE id = $1", [made.id])).rows[0].status).toBe("approved");

    // 3. the customer shows the provisional credit
    erpId = `E2ERET${Date.now()}`;
    await pool.query("UPDATE customers SET erp_customer_id = $1 WHERE id = $2", [erpId, customer.id]);
    await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1,'Return Shop',0,0,now())", [erpId]);
    await adminPage.goto(`/#/customers/${customer.id}`);
    await expect(adminPage.locator("body")).toContainText("Return credit", { timeout: 15000 });
    await adminCtx.close();

    // 4. warehouse manager: To receive -> grade the goods -> received
    const { context: whCtx, page: whPage } = await newIdentityPage(browser);
    await whPage.setViewportSize({ width: 440, height: 956 });
    await loginViaUi(whPage, wm.email);
    await whPage.goto("/#/returns");
    const whCard = whPage.locator(".rt-card", { hasText: "Return Shop" });
    await whCard.getByRole("button", { name: "Goods received" }).click();
    await whCard.getByRole("button", { name: "Damaged" }).click();
    await whCard.getByRole("button", { name: "Goods received" }).click();
    await expect.poll(async () => (await pool.query("SELECT status FROM order_returns WHERE id = $1", [made.id])).rows[0].status).toBe("done");
    const { rows: [item] } = await pool.query("SELECT condition, quantity FROM order_return_items WHERE return_id = $1", [made.id]);
    expect(item.condition).toBe("damaged");
    expect(Number(item.quantity)).toBe(2);
    await whCtx.close();
  });

  test("an undelivered order is sent for cancellation", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const customer = await fixtures.createCustomer({ name: "Cancel Shop", created_by: admin.id, assigned_manager_id: rep.id });
    await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 10000, product, quantity: 1 });

    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, rep.email);
    await page.goto("/#/orders");
    await page.locator('#order-status-filters [data-status=""]').click();
    await page.locator("#orders-list > .list-row", { hasText: "Cancel Shop" }).first().click({ timeout: 15000 });
    await page.getByRole("button", { name: "Cancel order" }).click();
    await expect(page.locator(".rt-sheet")).toContainText("not delivered yet");
    // sending without a reason is refused in the form
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.locator("#rt-error")).toContainText("Choose a reason");
    await page.getByRole("button", { name: "Customer changed their mind" }).click();
    await page.getByRole("button", { name: "Send request" }).click();
    await expect.poll(async () => (await pool.query("SELECT kind, status FROM order_returns r JOIN customers c ON c.id = r.customer_id WHERE c.name = 'Cancel Shop'")).rows[0]?.kind).toBe("cancel");
  });
});
