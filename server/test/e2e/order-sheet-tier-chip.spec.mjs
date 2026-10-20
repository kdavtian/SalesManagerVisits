import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-20 (screenshot of the order sheet): the customer's tier (Silver, Gold ...) is shown as a chip right after the
// payment method and the payment term, because it decides which price list the order is priced from.
test.describe("Order sheet: customer tier chip", () => {
  for (const tier of ["silver", "gold", "bronze"]) {
    test(`a ${tier} customer's order shows the ${tier} chip right after the payment term`, async ({ page, fixtures }) => {
      const admin = await fixtures.createUser("admin");
      const rep = await fixtures.createUser("sales_manager");
      const product = await fixtures.createProduct({ unit_price_amd: 30000 });
      const customer = await fixtures.createCustomer({ name: `Tier Chip ${tier}`, created_by: admin.id, assigned_manager_id: rep.id });
      await pool.query("UPDATE customers SET customer_tier = $1 WHERE id = $2", [tier, customer.id]);
      const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 60000, product, quantity: 2, payment_method: "invoice" });
      await pool.query("UPDATE orders SET payment_term_days = 45 WHERE id = $1", [order.id]);

      await page.setViewportSize({ width: 440, height: 900 });
      await loginViaUi(page, admin.email);
      await page.goto("/#/orders");
      await page.locator("#orders-list > .list-row", { hasText: `Tier Chip ${tier}` }).first().click({ timeout: 15000 });
      const chips = page.locator(".order-detail-head p .badge");
      await expect(chips.first()).toBeVisible({ timeout: 15000 });
      const texts = (await chips.allTextContents()).map((s) => s.trim());
      // status, payment method, payment term, then the tier
      const label = tier.charAt(0).toUpperCase() + tier.slice(1);
      expect(texts.slice(-4)[3] ?? texts[texts.length - 1]).toContain(label);
      const termIndex = texts.findIndex((s) => /45/.test(s));
      expect(termIndex).toBeGreaterThan(0);
      expect(texts[termIndex + 1]).toContain(label);
      await expect(page.locator(`.order-detail-head .tier-badge.tier-${tier}`)).toHaveCount(1);
    });
  }
});
