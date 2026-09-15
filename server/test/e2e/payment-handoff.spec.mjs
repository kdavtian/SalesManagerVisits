import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Payment collection", () => {
  test("@smoke an accountant can approve a rep's pending payment", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    const accountant = await fixtures.createUser("accountant");
    const customer = await fixtures.createCustomer({ created_by: manager.id });
    // Direct approve requires the cash to have already reached an
    // accountant's custody (see payments.js's custodyBlocksReview) -- a
    // payment still held by the collecting rep would 409 here, since in
    // reality that cash would need to go through the handoff chain first.
    const payment = await fixtures.createPayment({
      customer_id: customer.id,
      customer_name_snapshot: customer.name,
      sales_manager_id: manager.id,
      current_holder_id: accountant.id,
      amount_amd: 25000,
    });

    page.on("dialog", (d) => d.accept());
    await loginViaUi(page, accountant.email);
    await page.goto("/#/payments");
    // The row's outer card div and its inner .payment-row-main button both
    // carry data-payment-id -- .first() avoids a strict-mode violation on
    // the visibility check itself (the click below already scopes further).
    await expect(page.locator(`[data-payment-id="${payment.id}"]`).first()).toBeVisible({ timeout: 10000 });

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes(`/payments/${payment.id}/approve`)),
      page.locator(`[data-payment-id="${payment.id}"] .payment-approve-btn`).click(),
    ]);
    expect(response.ok()).toBeTruthy();
  });
});

test.describe("Cash handoff", () => {
  test("a sales_manager can hand their collected cash off to a sales_director", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    await fixtures.createUser("sales_director"); // the only valid first-hop recipient for a sales_manager
    const customer = await fixtures.createCustomer({ created_by: manager.id });
    const payment = await fixtures.createPayment({
      customer_id: customer.id,
      customer_name_snapshot: customer.name,
      sales_manager_id: manager.id,
      current_holder_id: manager.id,
      amount_amd: 15000,
    });

    page.on("dialog", (d) => d.accept());
    await loginViaUi(page, manager.email);
    await page.goto("/#/cash-handoffs");

    await expect(page.locator("#handoff-submit-all")).toBeEnabled({ timeout: 10000 });
    await page.locator("#handoff-submit-all").click();
    await expect(page.locator("#handoff-confirm-overlay")).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/cash-handoffs") && res.request().method() === "POST"),
      page.locator("#handoff-confirm-go").click(),
    ]);
    expect(response.ok()).toBeTruthy();
    const handoff = await response.json();
    fixtures.trackRow("cash_handoffs", handoff.id);
  });
});
