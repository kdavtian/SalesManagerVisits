import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

test.describe("Offline order creation and later synchronization", () => {
  test("an order placed while offline queues locally, then syncs once back online", async ({
    page,
    context,
    fixtures,
  }) => {
    const manager = await fixtures.createUser("sales_manager");
    // erp_customer_id set -- an order for a customer without one lands as a
    // draft (needs an ERP id picked first) instead of going straight
    // through, which isn't what this test is exercising.
    const customer = await fixtures.createCustomer({ created_by: manager.id, erp_customer_id: `E2E-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 5000 });

    await loginViaUi(page, manager.email);
    await page.goto(`/#/orders/new/${customer.id}`);
    // The picker navigates brand-first -- a brand chip, not the flat product
    // list, is what actually renders until one is picked (or a search is typed).
    await page.locator(`.chip[data-value="${product.brand}"]`).click();
    await expect(page.locator("#order-product-list")).toContainText(product.name, { timeout: 10000 });

    await page
      .locator(`[data-product-id="${product.id}"]`)
      .locator('[data-action="add"]')
      .click();
    await expect(page.locator("#order-cart-bar")).toBeVisible();

    await context.setOffline(true);
    await page.locator("#save-order-btn").click();

    // showOrderQueued()'s result screen -- confirms the app recognized the
    // network failure and queued rather than showing a raw error. Scoped to
    // the result panel itself (not a bare text search) since the top-bar
    // sync banner also renders "offline" text of its own at the same time.
    await expect(page.locator(".checkin-result").getByRole("heading", { name: /offline/i })).toBeVisible({
      timeout: 10000,
    });

    await context.setOffline(false);
    // window's 'online' listener (app.js) triggers flushQueue() automatically;
    // poll the database directly for the order actually landing rather than
    // depending on any particular UI re-render to prove it synced.
    await expect
      .poll(
        async () => {
          const { rows } = await pool.query(
            "SELECT id FROM orders WHERE customer_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1",
            [customer.id, manager.id]
          );
          if (rows[0]) fixtures.trackRow("orders", rows[0].id);
          return rows.length;
        },
        { timeout: 15000, message: "queued order should sync to the database once back online" }
      )
      .toBeGreaterThan(0);
  });
});
