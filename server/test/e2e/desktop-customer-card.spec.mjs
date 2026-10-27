import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 3: on a window of 1400 px and more the customer card is three columns -- facts + mini map + tiles +
// actions on the left, the whole visit history in the middle, tasks / orders / payments / files on the right. Sheets opened from
// the card dock to the right in place of the right column. Narrower windows, phones and the Customers panel keep their layout.
test.describe("Desktop customer card in three columns", () => {
  async function seed(fixtures) {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "Card Rep" });
    const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
    const erpId = `CARD${stamp}`;
    const customer = await fixtures.createCustomer({ name: `Card${stamp} Garage`, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId, lat: 40.1801, lng: 44.5101 });
    const near = await fixtures.createCustomer({ name: `Card${stamp} Neighbour`, created_by: admin.id, assigned_manager_id: rep.id, lat: 40.1812, lng: 44.5121 });
    // 35 visits: more than the phone's first page of 30
    await pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, amount_collected_amd, timestamp)
       SELECT $1, $2, 40.1801, 44.5101, 5, true, ARRAY['payment_collected'], 1000 * g, now() - (g || ' days')::interval FROM generate_series(1, 35) g`,
      [customer.id, rep.id]
    );
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd, qty, size_l) VALUES ($1, $2, current_date - 2, 250000, 10, '4')", [erpId, `X${stamp}`]);
    const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 77000, order_code: `APP${stamp}` });
    const payment = (
      await pool.query(
        `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
         VALUES ($1, $2, $3, 64000, now() - interval '1 day', $4, 'Card Rep', 'approved', $4, $4) RETURNING id`,
        [customer.id, customer.name, erpId, rep.id]
      )
    ).rows[0].id;
    return { admin, customer, near, order, payment, erpId, stamp };
  }
  async function cleanup({ customer, payment, erpId }) {
    await pool.query("DELETE FROM checkins WHERE customer_id = $1", [customer.id]);
    await pool.query("DELETE FROM payments WHERE id = $1", [payment]);
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
  }

  test("three columns, whole visit history, orders / payments / files panels, mini map, docked sheets", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const data = await seed(fixtures);
    try {
      await loginViaUi(page, data.admin.email);
      await page.goto(`/#/customers/${data.customer.id}`);
      const card = page.locator(".customer-detail-view.cd-three");
      await expect(card).toBeVisible({ timeout: 15000 });
      const [left, mid, right] = [card.locator(".cd-wcol-left"), card.locator(".cd-wcol-mid"), card.locator(".cd-wcol-right")];
      await expect(left.locator(".detail-facts-card")).toBeVisible();
      await expect(left.locator(".detail-actions-grid")).toBeVisible();
      // the columns sit side by side
      const [lb, mb, rb] = [await left.boundingBox(), await mid.boundingBox(), await right.boundingBox()];
      expect(lb.x + lb.width).toBeLessThanOrEqual(mb.x + 1);
      expect(mb.x + mb.width).toBeLessThanOrEqual(rb.x + 1);

      // the whole history, no "older visits" button, each row says what happened
      await expect(mid.locator(".checkin-row")).toHaveCount(35, { timeout: 15000 });
      await expect(mid.locator("#more-visits-btn")).toHaveCount(0);
      await expect(mid.locator(".checkin-row-outcomes").first()).toContainText("Payment collected");

      // orders: the app order Excel does not have yet + the Excel order
      const orders = right.locator(".cd-panel-orders");
      await expect(orders.locator(".cd-row", { hasText: `APP${data.stamp}` })).toBeVisible({ timeout: 15000 });
      await expect(orders.locator(".cd-row", { hasText: `X${data.stamp}` })).toBeVisible();
      await expect(right.locator(".cd-panel-payments [data-payment-row]", { hasText: "64,000" })).toBeVisible({ timeout: 15000 });
      await expect(right.locator(".cd-panel-files")).toBeVisible();

      // mini map: this customer's pin and the neighbour's
      await expect(left.locator(".cd-mini-map .leaflet-container")).toBeVisible({ timeout: 20000 });
      await expect(left.locator("path.cd-mini-map-self")).toHaveCount(1, { timeout: 15000 });
      await expect(left.locator("path.cd-mini-map-near").first()).toBeAttached();
      await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-customer-card.png` });

      // payments "View all" docks to the right and takes the right column's place; Esc gives it back
      await right.locator(".cd-panel-payments [data-panel-all]").click();
      const docked = page.locator(".sheet-overlay.sheet-docked > .sheet");
      await expect(docked).toContainText("Payments received");
      await expect(right).toBeHidden();
      await expect(mid.locator(".checkin-row").first()).toBeVisible();
      await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-customer-card-docked.png` });
      await page.keyboard.press("Escape");
      await expect(page.locator(".sheet-overlay.sheet-docked")).toHaveCount(0);
      await expect(right).toBeVisible();

      // an Excel order docks too
      await orders.locator(".cd-row", { hasText: `X${data.stamp}` }).click();
      await expect(docked).toContainText(`X${data.stamp}`, { timeout: 10000 });
      await page.keyboard.press("Escape");

      // a narrower window puts every block back where the two-column card has it
      await page.setViewportSize({ width: 1200, height: 900 });
      await expect(page.locator(".cd-wide")).toHaveCount(0);
      await expect(page.locator(".customer-detail-view .cd-col-side .checkin-row").first()).toBeVisible();
    } finally {
      await cleanup(data);
    }
  });

  test("phone and the Customers panel keep their own layout; a visit opened inside the panel does not close it", async ({ page, fixtures }) => {
    const data = await seed(fixtures);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await loginViaUi(page, data.admin.email);
      await page.goto(`/#/customers/${data.customer.id}`);
      await expect(page.locator(".customer-detail-view .checkin-row").first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator(".cd-wide")).toHaveCount(0);
      await expect(page.locator(".cd-mini-map")).toHaveCount(0);
      await expect(page.locator("#more-visits-btn")).toBeVisible();

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/#/customers");
      await page.locator("#customer-search").fill(`Card${data.stamp} Garage`);
      // the exact row: the search is debounced, so the first row can still be someone else's for a moment
      await page.locator("#customer-list > .list-row", { hasText: `Card${data.stamp} Garage` }).click();
      const panel = page.locator(".sheet-overlay.sheet-docked > .customer-panel");
      await expect(panel.locator(".checkin-row").first()).toBeVisible({ timeout: 15000 });
      await expect(panel.locator(".cd-wide")).toHaveCount(0);
      await panel.locator(".checkin-row").first().click();
      await expect(page.locator(".visit-detail-sheet")).toBeVisible();
      await expect(panel).toBeVisible();
    } finally {
      await cleanup(data);
    }
  });
});
