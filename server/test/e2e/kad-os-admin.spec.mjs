// KAD OS link, supplier side in the browser: the perks (discount / priority / promise / levels), linking a customer's KAD account, and
// starting + ending a campaign -- plus the APP badge on an app order in the Orders list.
import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

const SHOTS = process.env.KOS_SHOTS; // optional folder for review screenshots

test.use({ viewport: { width: 440, height: 956 } });

async function openAdminRow(page, rowId) {
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: /admin workspace/i }).click();
  await page.locator(rowId).click();
}

test.describe("KAD OS orders (supplier admin)", () => {
  test("perks: toggle + numbers save to the server", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    const before = (await pool.query("SELECT app_orders FROM app_settings WHERE id = 1")).rows[0]?.app_orders ?? {};
    try {
      await openAdminRow(page, "#row-kos-perks");
      await expect(page.locator("#kos-perks")).toBeVisible();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/perks-440.png`, fullPage: true });
      const pct = page.locator('input[data-key="discount_pct"]');
      await expect(pct).toHaveValue("2");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/app-orders/settings") && r.request().method() === "PUT"),
        pct.fill("3").then(() => pct.blur()),
      ]);
      await expect(page.locator("#kos-saved")).toBeVisible();
      await page.locator("#kos-priority-on").click();
      await expect(page.locator("#kos-priority-on")).toHaveAttribute("aria-checked", "false");
      const saved = (await pool.query("SELECT app_orders FROM app_settings WHERE id = 1")).rows[0].app_orders;
      expect(saved.discount_pct).toBe(3);
      expect(saved.priority_enabled).toBe(false);
      // an invalid number is refused by the server and the field goes back
      const days = page.locator('input[data-key="promise_working_days"]');
      await days.fill("99");
      await days.blur();
      await expect(days).toHaveValue("2");
    } finally {
      await pool.query("INSERT INTO app_settings (id, app_orders) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET app_orders = EXCLUDED.app_orders", [JSON.stringify(before)]);
    }
  });

  test("add a customer (its KAD OS account + connection code), then start and end a campaign", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const customer = await fixtures.createCustomer({ created_by: admin.id, name: `E2E KOS Shop ${Date.now()}`, erp_customer_id: `E2E-KOS-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000, name: `E2E KOS Oil ${Date.now()}` });
    await pool.query("UPDATE products SET bronze_price_amd = 10000, silver_price_amd = 10000, net_cost_amd = 6000 WHERE id = $1", [product.id]);
    let acctId = null;
    await loginViaUi(page, admin.email);
    try {
      await openAdminRow(page, "#row-kos-perks");
      await page.locator("#kos-link-add").click();
      await page.locator("#kos-cust-q").fill(customer.erp_customer_id);
      await page.locator("[data-pick]").first().click();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/link-440.png` });
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/app-orders/accounts") && r.request().method() === "POST" && r.ok()),
        page.locator("#kos-link-save").click(),
      ]);
      // the connection code is shown once, ready to copy
      await expect(page.locator("#kos-code")).toHaveValue(/^[A-Za-z0-9_-]{40,}$/);
      if (SHOTS) {
        await page.waitForTimeout(600); // the sheet slides in
        await page.screenshot({ path: `${SHOTS}/code-440.png` });
      }
      await page.locator("#kos-code-copy").click();
      await expect(page.locator("#kos-code-copied")).toBeVisible();
      await page.locator('.sheet-overlay [data-action="close"]').click();
      await expect(page.locator("#kos-links")).toContainText(customer.name);
      const link = (await pool.query("SELECT l.user_id, u.role FROM partner_links l JOIN users u ON u.id = l.user_id WHERE l.customer_id = $1", [customer.id])).rows[0];
      expect(link.role).toBe("customer");
      acctId = link.user_id;

      await page.locator("#admin-section-close").click();
      await page.locator("#row-kos-campaigns").click();
      await page.locator("#kos-campaign-new").click();
      // empty form: the bar says what is missing
      await page.locator("#kc-create").click();
      await expect(page.locator("#kc-error")).toBeVisible();
      await page.locator("#kc-title").fill("E2E autumn offer");
      await page.locator("#kc-percent").fill("45"); // would sell under cost (6000 net, 10000 list)
      await page.locator("#kc-prod-q").fill(product.name);
      await page.locator("[data-add-prod]").first().click();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/campaign-440.png` });
      await page.locator("#kc-create").click();
      await expect(page.locator("#kc-error")).toContainText(/below cost/i);
      await page.locator("#kc-percent").fill("10");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/app-orders/campaigns") && r.request().method() === "POST" && r.ok()),
        page.locator("#kc-create").click(),
      ]);
      const card = page.locator("#kos-campaign-list .user-row", { hasText: "E2E autumn offer" });
      await expect(card).toBeVisible();
      await expect(card).toContainText(/Running/i);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/campaigns-440.png`, fullPage: true });
      await card.locator('[data-act="end"]').click();
      await expect(card).toContainText(/Ended/i);
      await card.locator('[data-act="delete"]').click();
      await expect(page.locator("#kos-campaign-list")).not.toContainText("E2E autumn offer");
    } finally {
      await pool.query("DELETE FROM campaigns WHERE title = 'E2E autumn offer'");
      await pool.query("DELETE FROM partner_links WHERE customer_id = $1", [customer.id]);
      if (acctId) await pool.query("DELETE FROM users WHERE id = $1", [acctId]);
    }
  });

  test("an app order shows the APP badge in the Orders list", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const acct = await fixtures.createUser("sales_manager", { name: "KAD OS - E2E Badge" });
    const customer = await fixtures.createCustomer({ created_by: admin.id, erp_customer_id: `E2E-KOB-${Date.now()}` });
    const product = await fixtures.createProduct({ unit_price_amd: 10000 });
    const { rows } = await pool.query(
      `INSERT INTO orders (customer_id, user_id, status, total_amd, order_code, payment_method, approval_status, placed_via_app, promised_date)
       VALUES ($1, $2, 'submitted', 9800, $3, 'invoice', 'not_required', true, current_date + 2) RETURNING id`,
      [customer.id, acct.id, `E${Date.now()}`.slice(0, 10)]
    );
    fixtures.trackRow("orders", rows[0].id);
    await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'x', 10000, 1, 10000)", [rows[0].id, product.id]);
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");
    const row = page.locator(`[data-order-id="${rows[0].id}"]`);
    await expect(row.locator(".app-badge")).toHaveText("APP");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/orders-app-badge-440.png` });
    await row.click();
    await expect(page.locator("#order-detail-actions")).toBeVisible();
    await expect(page.locator(".order-detail-head .app-badge")).toBeVisible();
    await expect(page.locator(".sheet, .order-detail-side").first()).toContainText(/Delivery promise/i);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/order-detail-app-440.png` });
  });
});
