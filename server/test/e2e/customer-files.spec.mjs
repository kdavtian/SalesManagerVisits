import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-26: the customer card's sheets must open at once (cached), Photos became "Files" (Photos + Documents) with an X, and a long
// press on the Last order tile opens all orders.
async function seedCustomer(fixtures) {
  const admin = await fixtures.createUser("admin");
  const erpId = `E2E-CF-${Date.now()}`;
  const customer = await fixtures.createCustomer({ created_by: admin.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1,'x',500000,0,now())", [erpId]);
  await pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, brand, product_name, size_l, qty, unit_price_amd, revenue_amd) VALUES ($1,'E2E-O1', current_date - 1, 'Castrol', 'Edge', '4', 1, 80888000, 80888000)",
    [erpId]
  );
  return { admin, customer, erpId };
}

test.describe("Customer card sheets", () => {
  test("Files sheet: X closes it, Photos + Documents sections, thumbnails; payments reopen from the cache", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { admin, customer, erpId } = await seedCustomer(fixtures);
    try {
      const checkin = (
        await pool.query(
          `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes) VALUES ($1,$2,40.18,44.51,5,true,ARRAY['other']) RETURNING id`,
          [customer.id, admin.id]
        )
      ).rows[0].id;
      fixtures.track("checkins", checkin);
      await pool.query("INSERT INTO checkin_photos (checkin_id, photo_path) VALUES ($1, 'missing-1.jpg'), ($1, 'missing-2.jpg')", [checkin]);
      let paymentsCalls = 0;
      await page.route(`**/api/customers/${customer.id}/payments-received`, (route) => {
        paymentsCalls += 1;
        return route.fulfill({ json: { total_amd: 21000, rows: [{ date: "2026-10-16", source: "excel", amount_amd: 21000 }] } });
      });
      await loginViaUi(page, admin.email);
      await page.goto(`/#/customers/${customer.id}`);

      // Files: renamed, two sections, thumbnails (not full size), X to close
      await page.locator("#customer-photos-btn").click();
      const sheet = page.locator(".customer-files-sheet");
      await expect(sheet.locator("h2")).toHaveText("Files");
      await expect(sheet.locator(".list-group-heading", { hasText: "Photos" })).toContainText("2");
      await expect(sheet.locator(".list-group-heading", { hasText: "Documents" })).toBeVisible();
      await expect(sheet.locator(".checkin-photo")).toHaveCount(2);
      expect(await sheet.locator(".checkin-photo").first().getAttribute("src")).toContain("size=thumb");
      await sheet.locator(".sheet-close-x").click();
      await expect(sheet).toHaveCount(0);

      // payments: first open fetches, the second shows the kept copy at once and refreshes quietly
      await page.locator('[data-stat="debt"]').click();
      await expect(page.locator(".payments-received-row").first()).toBeVisible();
      await page.locator(".sheet-close-x").click();
      await page.locator('[data-stat="debt"]').click();
      await expect(page.locator(".payments-received-row").first()).toBeVisible();
      await expect.poll(() => paymentsCalls).toBeGreaterThanOrEqual(2);
      await page.locator(".sheet-close-x").click();
    } finally {
      await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
      await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
    }
  });

  test("last order: an 8-digit price stays on one line; a long press opens all orders", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { admin, customer, erpId } = await seedCustomer(fixtures);
    try {
      await loginViaUi(page, admin.email);
      await page.goto(`/#/customers/${customer.id}`);
      const tile = page.locator('[data-stat="last-order"]');
      await expect(tile).toBeEnabled();
      await tile.click();
      const total = page.locator(".order-detail-meta .erp-debt-amount");
      await expect(total).toContainText("80,888,000");
      expect((await total.boundingBox()).height).toBeLessThan(30);
      const line = page.locator(".erp-line-row > span:last-child").first();
      await expect(line).toContainText("80,888,000");
      expect((await line.boundingBox()).height).toBeLessThan(30);
      await page.locator('[data-action="close-order-detail"]').first().click();

      // long press (touch hold) -> all orders
      const box = await tile.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
      await expect(page).toHaveURL(new RegExp(`#/customers/${customer.id}/orders$`));
      await expect(page.locator(".erp-order-row").first()).toBeVisible();
    } finally {
      await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
      await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
    }
  });
});

test("the customer card still opens when the visit list fails to load (it used to spin forever)", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { admin, customer, erpId } = await seedCustomer(fixtures);
  try {
    await page.route(`**/api/customers/${customer.id}/checkins**`, (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await expect(page.locator("#customer-detail-name")).toBeVisible();
    await expect(page.locator(".customer-partial-error")).toBeVisible();
    await expect(page.locator(".customer-detail-view .loading-state")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  }
});
