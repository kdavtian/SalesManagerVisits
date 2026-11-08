import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// The request card (owner, 2026-11-08): a push opens ONE full-screen card with the details and big Approve / Deny buttons in a fixed
// bottom bar; Deny needs a written reason (inline field, no dialog); a request someone already decided shows who and offers no buttons.
async function pendingDiscountOrder(fixtures, rep, customer, product) {
  return fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 18000, discount_pct: 10, approval_status: "pending", product, quantity: 2 });
}

test.describe("Request card", () => {
  test("390 px, English: the list opens the card; Deny needs a reason and is saved with it", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, erp_customer_id: `E2E-RQ-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const order = await pendingDiscountOrder(fixtures, rep, customer, product);

    await loginViaUi(page, director.email);
    await page.goto("/#/requests");
    const item = page.locator(`[data-open="#/requests/discount/${order.id}"]`);
    await expect(item).toBeVisible({ timeout: 10000 });
    await expect(item).toContainText(customer.name);
    await item.click();
    await expect(page).toHaveURL(new RegExp(`#/requests/discount/${order.id}$`));

    const card = page.locator("#req-card");
    await expect(card).toContainText(order.order_code);
    await expect(card).toContainText(customer.erp_customer_id);
    await expect(card).toContainText("10%");
    const bar = page.locator(".req-bar");
    await expect(bar.locator('[data-act="approve"]')).toBeVisible();
    const barBox = await bar.boundingBox();
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(844);
    const approveBox = await bar.locator('[data-act="approve"]').boundingBox();
    expect(approveBox.height).toBeGreaterThanOrEqual(44);

    await bar.locator('[data-act="deny"]').click();
    const send = bar.locator('[data-act="deny-send"]');
    await expect(page.locator("#req-reason")).toBeFocused();
    await expect(send).toBeDisabled();
    // Cancel goes back to the two buttons without deciding anything
    await bar.locator('[data-act="cancel"]').click();
    await expect(bar.locator('[data-act="approve"]')).toBeVisible();
    await bar.locator('[data-act="deny"]').click();
    await page.locator("#req-reason").fill("Max 5% for this customer");
    await expect(send).toBeEnabled();
    await Promise.all([page.waitForResponse((r) => r.url().includes(`/orders/${order.id}/reject-discount`) && r.status() === 200), send.click()]);

    await expect(page.locator(".req-status-denied")).toContainText("Max 5% for this customer");
    await expect(page.locator(".req-bar")).toHaveCount(0);
    const { rows } = await pool.query("SELECT approval_status, approval_reason, approved_by FROM orders WHERE id = $1", [order.id]);
    expect(rows[0]).toEqual({ approval_status: "rejected", approval_reason: "Max 5% for this customer", approved_by: director.id });
  });

  test("320 px, Armenian: Approve is one tap and the saved status matches", async ({ page, fixtures }) => {
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await page.setViewportSize({ width: 320, height: 640 });
    const director = await fixtures.createUser("sales_director");
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, erp_customer_id: `E2E-RQ2-${Date.now()}`, name: "Արարատ Ավտո ՍՊԸ երկար անունով խանութ" });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const order = await pendingDiscountOrder(fixtures, rep, customer, product);

    await loginViaUi(page, director.email);
    await page.goto(`/#/requests/discount/${order.id}`);
    const approve = page.locator('.req-bar [data-act="approve"]');
    await expect(approve).toHaveText("Հաստատել", { timeout: 10000 });
    await expect(page.locator(".req-bar [data-act=deny]")).toHaveText("Մերժել");
    // nothing wider than the screen
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await Promise.all([page.waitForResponse((r) => r.url().includes(`/orders/${order.id}/approve-discount`) && r.status() === 200), approve.click()]);
    await expect(page.locator(".req-status-approved")).toBeVisible();
    await expect(page.locator(".req-bar")).toHaveCount(0);
    const { rows } = await pool.query("SELECT approval_status FROM orders WHERE id = $1", [order.id]);
    expect(rows[0].approval_status).toBe("approved");
  });

  test("a request someone else already decided shows who and offers no buttons; an outsider is told it is not theirs", async ({ page, browser, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const director = await fixtures.createUser("sales_director");
    const ceo = await fixtures.createUser("ceo", { name: "E2E Decider CEO" });
    const rep = await fixtures.createUser("sales_manager");
    const otherRep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, erp_customer_id: `E2E-RQ3-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const order = await pendingDiscountOrder(fixtures, rep, customer, product);
    await pool.query("UPDATE orders SET approval_status = 'rejected', approved_by = $2, approved_at = now(), approval_reason = 'Too deep' WHERE id = $1", [order.id, ceo.id]);

    await loginViaUi(page, director.email);
    await page.goto(`/#/requests/discount/${order.id}`);
    await expect(page.locator(".req-status-denied")).toContainText("Already denied by E2E Decider CEO", { timeout: 10000 });
    await expect(page.locator(".req-status-denied")).toContainText("Too deep");
    await expect(page.locator(".req-bar")).toHaveCount(0);

    const { context, page: repPage } = await newIdentityPage(browser);
    await loginViaUi(repPage, otherRep.email);
    await repPage.goto(`/#/requests/discount/${order.id}`);
    await expect(repPage.locator("#req-card")).toContainText("not for you", { timeout: 10000 });
    await expect(repPage.locator(".req-bar")).toHaveCount(0);
    await context.close();
  });
});
