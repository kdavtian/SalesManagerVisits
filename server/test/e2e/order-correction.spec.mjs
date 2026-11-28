import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: admin / CEO / accountant correct a delivered order from its sheet, with a reason; the correction shows on the order.
test("@smoke the accountant corrects a delivered order with a reason and the correction shows on it", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const rep = await fixtures.createUser("sales_manager");
  const product = await fixtures.createProduct({ unit_price_amd: 5000 });
  const customer = await fixtures.createCustomer({ name: "Correct Me Garage", created_by: rep.id, assigned_manager_id: rep.id });
  const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "delivered", total_amd: 10000, product, quantity: 2, payment_method: "invoice" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, acc.email);
  await page.goto(`/#/orders?open=${order.id}`);
  const sheet = page.locator(".order-detail-sheet");
  await sheet.locator('[data-action="correct-order"]').click({ timeout: 15000 });
  await sheet.locator('.order-edit-row [data-action="dec"]').first().click();
  await sheet.locator("#edit-order-save").click();
  await expect(sheet.locator("#order-detail-error")).toBeVisible(); // no reason yet
  await sheet.locator("#edit-correct-reason").fill("2 typed instead of 1");
  await page.screenshot({ path: "test-results/order-correct-sheet.png" });
  await sheet.locator("#edit-order-save").click();
  await expect(page.locator(".order-correction")).toContainText("2 typed instead of 1", { timeout: 10000 });
  await expect(page.locator(".order-correction")).toContainText("10,000");
  await page.screenshot({ path: "test-results/order-corrected.png" });
  const { rows } = await pool.query("SELECT quantity FROM order_items WHERE order_id = $1", [order.id]);
  expect(Number(rows[0].quantity)).toBe(1);
});

// Phase 0 item 0.18 (2026-11-28): once the customer signed, only the admin or the CEO may correct the order -- the accountant's sheet shows no
// Edit (correct) button any more (the server answers 423 too), the admin's still does.
test("a signed delivered order: no correct button for the accountant, the admin still has it", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const product = await fixtures.createProduct({ unit_price_amd: 5000 });
  const customer = await fixtures.createCustomer({ name: "Signed Garage", created_by: rep.id, assigned_manager_id: rep.id });
  const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "delivered", total_amd: 10000, product, quantity: 2, payment_method: "invoice" });
  await pool.query("UPDATE orders SET signed_at = now() WHERE id = $1", [order.id]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await loginViaUi(page, acc.email);
    await page.goto(`/#/orders?open=${order.id}`);
    const sheet = page.locator(".order-detail-sheet");
    await expect(sheet.locator(".order-signed-note")).toBeVisible({ timeout: 15000 });
    await expect(sheet.locator('[data-action="record-order"]')).toBeVisible();
    await expect(sheet.locator('[data-action="correct-order"]')).toHaveCount(0);
    await page.screenshot({ path: `test-results/order-signed-accountant-${width}.png` });
    await page.context().clearCookies();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/orders?open=${order.id}`);
  await expect(page.locator('.order-detail-sheet [data-action="correct-order"]')).toBeVisible({ timeout: 15000 });
});
