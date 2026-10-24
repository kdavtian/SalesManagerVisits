import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-23: the delivery driver reaches the customer -> a banner with a one-tap "Delivered" (or automatic), chosen in Settings.
test.use({ geolocation: { latitude: 40.2, longitude: 44.5, accuracy: 10 }, permissions: ["geolocation"] });
// The mode is one global setting: these tests must not run side by side.
test.describe.configure({ mode: "serial" });

async function setup(fixtures, mode) {
  await pool.query(
    `INSERT INTO app_settings (id, delivery_arrival) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET delivery_arrival = EXCLUDED.delivery_arrival`,
    [JSON.stringify({ mode, radius_m: 80, dwell_seconds: 0 })]
  );
  const driver = await fixtures.createUser("delivery_manager");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Arrival Shop", lat: 40.2, lng: 44.5 });
  const product = await fixtures.createProduct({ unit: "4L" });
  const order = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "packed_stock_out", total_amd: 45000, product, quantity: 3 });
  const { rows } = await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date, $1) RETURNING id", [driver.id]);
  await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, 1)", [rows[0].id, order.id]);
  return { driver, order, routeId: rows[0].id };
}
const cleanup = async (driverId) => {
  await pool.query("DELETE FROM delivery_routes WHERE driver_id = $1", [driverId]);
  await pool.query("UPDATE app_settings SET delivery_arrival = NULL WHERE id = 1");
};
const orderStatus = async (id) => (await pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

test("suggest mode: the driver at the customer sees a banner and one tap delivers the order", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { driver, order } = await setup(fixtures, "suggest");
  try {
    await loginViaUi(page, driver.email);
    const banner = page.locator("#arrival-banner");
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText("E2E Arrival Shop");
    await expect(banner).toContainText("45,000");
    await expect(banner).not.toContainText(/AMD AMD|դր\. դր/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await orderStatus(order.id)).toBe("packed_stock_out");
    await banner.locator('[data-act="deliver"]').click();
    await expect(banner).toBeHidden({ timeout: 10000 });
    expect(await orderStatus(order.id)).toBe("delivered");
  } finally {
    await cleanup(driver.id);
  }
});

test("auto mode: the order is delivered by the arrival itself", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { driver, order } = await setup(fixtures, "auto");
  try {
    await loginViaUi(page, driver.email);
    await expect(page.locator("#arrival-banner")).toContainText("E2E Arrival Shop", { timeout: 20000 });
    await expect.poll(() => orderStatus(order.id), { timeout: 10000 }).toBe("delivered");
    await expect(page.locator('#arrival-banner [data-act="route"]')).toBeVisible();
  } finally {
    await cleanup(driver.id);
  }
});

test("off mode: nothing is shown and nothing changes", async ({ page, fixtures }) => {
  const { driver, order } = await setup(fixtures, "off");
  try {
    await loginViaUi(page, driver.email);
    await page.waitForTimeout(4000);
    await expect(page.locator("#arrival-banner")).toHaveCount(0);
    expect(await orderStatus(order.id)).toBe("packed_stock_out");
  } finally {
    await cleanup(driver.id);
  }
});

test("admin chooses the mode in Settings", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pool.query("UPDATE app_settings SET delivery_arrival = NULL WHERE id = 1");
  const admin = await fixtures.createUser("admin");
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings?section=a-sales");
    await page.locator("#row-delivery-arrival").click();
    const auto = page.locator('[data-mode="auto"]');
    await expect(auto).toBeVisible();
    await expect(page.locator('[data-mode="suggest"]')).toHaveAttribute("aria-pressed", "true"); // the default
    await auto.click();
    await expect(page.locator('[data-mode="auto"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('input[data-key="radius_m"]')).toBeVisible();
    const { rows } = await pool.query("SELECT delivery_arrival FROM app_settings WHERE id = 1");
    expect(rows[0].delivery_arrival.mode).toBe("auto");
  } finally {
    await pool.query("UPDATE app_settings SET delivery_arrival = NULL WHERE id = 1");
  }
});
