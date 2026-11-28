// Phase 0 items 0.1, 0.8 and 0.21 (owner 2026-11-28): work saved on the phone is never deleted by the phone, is sent only under the login
// that saved it, a 502 / no answer queues instead of failing, and a too-old app shows the update screen without "Later" while the work waits.
import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

async function openOrderSheet(page, customer, product) {
  await page.goto(`/#/orders/new/${customer.id}`);
  await page.locator(`[data-chip="${product.brand}"]`).click();
  await expect(page.locator("#order-product-list")).toContainText(product.name, { timeout: 10000 });
  await page.locator(`[data-product-id="${product.id}"]`).locator('[data-action="add"]').click();
  await page.locator("#order-cart-bar").click();
}

const queuedHeading = (page) => page.locator(".checkin-result").getByRole("heading", { name: /saved on this phone/i });

async function ordersOf(customerId) {
  const { rows } = await pool.query("SELECT id, user_id FROM orders WHERE customer_id = $1 ORDER BY id", [customerId]);
  return rows;
}

async function setup(fixtures) {
  const manager = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: manager.id, erp_customer_id: `E2E-Q-${Date.now()}-${Math.random()}` });
  const product = await fixtures.createProduct({ unit_price_amd: 5000 });
  return { manager, customer, product };
}

test.describe("Offline queue safety", () => {
  test("a queued order the server refuses is kept as 'needs attention' with the reason, survives a reload, and only the rep discards it", async ({ page, context, fixtures }) => {
    const { manager, customer, product } = await setup(fixtures);
    await loginViaUi(page, manager.email);
    await openOrderSheet(page, customer, product);
    await context.setOffline(true);
    await page.locator("#save-order-btn").click();
    await expect(queuedHeading(page)).toBeVisible({ timeout: 10000 });

    // back online, the server refuses it (e.g. the customer was deleted meanwhile): before, the phone deleted the order without a word
    await page.route("**/api/orders", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Customer not found" }) }) : route.fallback()
    );
    await context.setOffline(false);
    await expect(page.locator("#sync-banner")).toContainText(/couldn.t sync/i, { timeout: 15000 });

    await page.reload();
    await expect(page.locator("#sync-banner")).toContainText(/couldn.t sync/i, { timeout: 15000 });
    await page.locator("#sync-banner").click();
    const sheet = page.locator(".sync-queue-sheet");
    await expect(sheet.locator(".sync-queue-item-stuck")).toHaveCount(1);
    await expect(sheet).toContainText("Needs attention");
    await expect(sheet.locator(".sync-queue-error")).toContainText(/no longer exists/i);
    await expect(sheet.locator(".sync-queue-refused-hint")).toBeVisible();

    // Retry gets the same refusal: still kept
    await sheet.locator('[data-action="retry"]').click();
    await expect(sheet.locator(".sync-queue-item-stuck")).toHaveCount(1);

    // Discard = two taps (the second confirms)
    await sheet.locator("[data-discard]").click();
    await sheet.locator("[data-discard]").click();
    await expect(page.locator(".sync-queue-sheet")).toHaveCount(0);
    await expect(page.locator("#sync-banner")).toBeHidden();
    expect(await ordersOf(customer.id)).toHaveLength(0);
  });

  test("work queued by one person is never sent under another person's login; it is sent when the first person signs in again", async ({ page, context, fixtures }) => {
    const { manager: repA, customer, product } = await setup(fixtures);
    const repB = await fixtures.createUser("sales_manager");
    await loginViaUi(page, repA.email);
    await openOrderSheet(page, customer, product);
    await context.setOffline(true);
    await page.locator("#save-order-btn").click();
    await expect(queuedHeading(page)).toBeVisible({ timeout: 10000 });

    // signal back but the server busy (503 during a deploy): the order waits untouched, not flagged
    await page.route("**/api/orders", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 503, body: "busy" }) : route.fallback()));
    await context.setOffline(false);
    await expect(page.locator("#sync-banner")).toBeVisible();
    await expect(page.locator("#sync-banner")).not.toContainText(/couldn.t sync/i);
    await page.unroute("**/api/orders");

    // A's session ends; B signs in on the same phone
    await context.clearCookies();
    await loginViaUi(page, repB.email);
    await page.waitForTimeout(2500);
    expect(await ordersOf(customer.id)).toHaveLength(0);
    await expect(page.locator("#sync-banner")).toBeHidden();

    // A signs in again: the order is sent, as A
    await context.clearCookies();
    await loginViaUi(page, repA.email);
    await expect.poll(async () => (await ordersOf(customer.id)).length, { timeout: 15000 }).toBe(1);
    const [order] = await ordersOf(customer.id);
    fixtures.trackRow("orders", order.id);
    expect(order.user_id).toBe(repA.id);
  });

  test("a 502 on Save queues the order instead of showing an error; Retry sends it once", async ({ page, fixtures }) => {
    const { manager, customer, product } = await setup(fixtures);
    await loginViaUi(page, manager.email);
    await openOrderSheet(page, customer, product);
    let refused = 0;
    await page.route("**/api/orders", (route) => {
      if (route.request().method() === "POST" && refused === 0) {
        refused += 1;
        return route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" });
      }
      return route.fallback();
    });
    await page.locator("#save-order-btn").click();
    await expect(queuedHeading(page)).toBeVisible({ timeout: 10000 });
    await page.locator("#order-queue-btn").click();
    await page.locator('.sync-queue-sheet [data-action="retry"]').click();
    await expect.poll(async () => (await ordersOf(customer.id)).length, { timeout: 15000 }).toBe(1);
    fixtures.trackRow("orders", (await ordersOf(customer.id))[0].id);
  });

  test("426 update_required: the update screen has no 'Later', and the order waits on the phone", async ({ page, fixtures }) => {
    const { manager, customer, product } = await setup(fixtures);
    await loginViaUi(page, manager.email);
    await openOrderSheet(page, customer, product);
    await page.route("**/api/orders", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 426, contentType: "application/json", body: JSON.stringify({ error: "too old", code: "update_required", min_version: "9.0.0" }) })
        : route.fallback()
    );
    await page.locator("#save-order-btn").click();
    const overlay = page.locator("#update-overlay");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(overlay).toContainText("Update the app");
    await expect(overlay.locator("#update-refresh-btn")).toBeVisible();
    await expect(overlay.locator("#update-dismiss")).toHaveCount(0);
    await expect(queuedHeading(page)).toHaveCount(1);
    expect(await ordersOf(customer.id)).toHaveLength(0);
  });
});
