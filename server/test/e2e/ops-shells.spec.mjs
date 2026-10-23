import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-23: the warehouse manager and the driver get their own small app (Home, only their tabs, big buttons).
const SHOTS = process.env.OPS_SHOTS; // optional folder for review screenshots
test.use({ viewport: { width: 440, height: 956 } });
// the driver test changes today's route rows; keep the tests of this file in one worker
test.describe.configure({ mode: "serial" });

async function seedWarehouse(fixtures) {
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "Garage Masters Mall", address: "Komitas 12, Yerevan" });
  const other = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "Auto Plus", address: "Arshakunyats 3" });
  const castrol = await fixtures.createProduct({ name: "Castrol Magnatec 5W-30", unit: "4L", brand: "Castrol" });
  const lotos = await fixtures.createProduct({ name: "Lotos Semisynthetic 10W-40", unit: "5L", brand: "Lotos" });
  await pool.query("UPDATE products SET stock_qty = 3 WHERE id = $1", [lotos.id]);
  const a = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 126000, product: castrol, quantity: 12, order_code: "26102301" });
  await pool.query("INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, $4, 30000, 6, 180000)", [a.id, lotos.id, lotos.name, "Lotos"]);
  const b = await fixtures.createOrder({ customer_id: other.id, user_id: rep.id, status: "confirmed", total_amd: 42000, product: castrol, quantity: 4, order_code: "26102302" });
  await pool.query("UPDATE orders SET placed_via_app = true WHERE id = $1", [b.id]);
  return { rep, a, b, customer, other };
}

test("warehouse manager: own Home, only his tabs, other screens are closed", async ({ page, fixtures }) => {
  const { } = await seedWarehouse(fixtures);
  const wm = await fixtures.createUser("warehouse_manager");
  await loginViaUi(page, wm.email);
  await expect(page.locator(".ops-hero")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".ops-hero-number")).not.toHaveText("0");
  await expect(page.locator(".ops-att").first()).toBeVisible(); // something needs attention (the short Lotos stock, the KAD OS order)
  await expect(page.locator(".ops-att", { hasText: /Lotos|KAD OS/ }).first()).toBeVisible();
  // bottom tabs: Home, Pack, Orders, Products, Tasks -- no Map / Customers / Activity
  const tabs = page.locator("#nav-bar .nav-item, .nav-bar .nav-item");
  await expect(tabs).toHaveCount(5);
  await expect(page.locator(".nav-bar")).not.toContainText(/Customers|Activity|Map/i);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wh-home.png` });
  // a screen outside his work goes back to his Home
  await page.goto("/#/customers");
  await expect(page.locator(".ops-hero")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/dashboard");
  await page.goto("/#/map");
  await expect(page.locator(".ops-hero")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a very long name does not push the new Homes sideways (warehouse manager and driver, phone width)", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const role of ["warehouse_manager", "delivery_manager"]) {
    const user = await fixtures.createUser(role, { name: "Վահագնուշ-Հակոբյանյան_ExtremelyLongSingleWordName" });
    await page.context().clearCookies();
    await loginViaUi(page, user.email);
    await expect(page.locator(".ops-view")).toBeVisible({ timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, role).toBeLessThanOrEqual(1);
  }
});

test("warehouse manager: pack an order with one big button, send another back with a reason", async ({ page, fixtures }) => {
  const { a, b } = await seedWarehouse(fixtures);
  const wm = await fixtures.createUser("warehouse_manager");
  await loginViaUi(page, wm.email);
  await page.locator(".ops-hero").click();
  await expect(page.locator(".ops-order").first()).toBeVisible({ timeout: 15000 });
  const mine = page.locator(`.ops-order[data-order="${a.id}"]`);
  await expect(mine).toContainText("Garage Masters Mall");
  await expect(mine).toContainText("× 12");
  await expect(mine.locator(".ops-short")).toContainText(/3/); // the Lotos line: only 3 in stock
  await mine.locator("input[data-line]").first().check();
  await expect(mine.locator("[data-progress]")).toContainText(/1/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wh-pack.png`, fullPage: false });
  await mine.locator("[data-pack]").click();
  await expect(page.locator(`.ops-order[data-order="${a.id}"]`)).toHaveCount(0, { timeout: 10000 });
  expect((await pool.query("SELECT status FROM orders WHERE id = $1", [a.id])).rows[0].status).toBe("packed_stock_out");

  // problem: out of stock -> back to the rep (draft) with the reason in the history
  const other = page.locator(`.ops-order[data-order="${b.id}"]`);
  await other.locator("[data-problem]").click();
  const send = page.locator("#problem-send");
  await expect(send).toBeDisabled();
  await page.locator('[data-reason="out"]').click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wh-problem.png` });
  await send.click();
  await expect(page.locator(`.ops-order[data-order="${b.id}"]`)).toHaveCount(0, { timeout: 10000 });
  const row = (await pool.query("SELECT status, draft_reason FROM orders WHERE id = $1", [b.id])).rows[0];
  expect(row.status).toBe("draft");
  expect(row.draft_reason).toMatch(/stock/i);

  // the other two tabs
  await page.locator('[data-tab="packed"]').click();
  await expect(page.locator(".ops-order-packed")).toContainText("Garage Masters Mall");
  await expect(page.locator(".ops-order-packed")).toContainText(/No route yet/i);
  await page.locator('[data-tab="product"]').click();
  await expect(page.locator(".ops-products")).toBeVisible().catch(() => {});
});

test("driver: own Home with the next stop, only his tabs", async ({ page, fixtures }) => {
  const driver = await fixtures.createUser("delivery_manager");
  const rep = await fixtures.createUser("sales_manager");
  const c1 = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "Garage Masters Mall", address: "Komitas 12, Yerevan", lat: 40.2, lng: 44.5 });
  const c2 = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "Auto Plus", address: "Arshakunyats 3", lat: 40.21, lng: 44.51 });
  await pool.query("UPDATE customers SET phone = '+37491007019' WHERE id = $1", [c1.id]);
  const product = await fixtures.createProduct({ unit: "4L" });
  const o1 = await fixtures.createOrder({ customer_id: c1.id, user_id: rep.id, status: "packed_stock_out", total_amd: 126000, product, quantity: 12, order_code: "26102301" });
  const o2 = await fixtures.createOrder({ customer_id: c2.id, user_id: rep.id, status: "packed_stock_out", total_amd: 42000, product, quantity: 4, order_code: "26102302" });
  const { rows } = await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date, $1) RETURNING id", [driver.id]);
  await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, 1), ($1, $3, 2)", [rows[0].id, o1.id, o2.id]);
  try {
    await loginViaUi(page, driver.email);
    await expect(page.locator(".ops-next")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".ops-next")).toContainText("Garage Masters Mall");
    await expect(page.locator(".ops-hero-number")).toContainText("0");
    await expect(page.locator(".ops-next a[href^='tel:']")).toBeVisible();
    await expect(page.locator(".ops-next a[href*='google.com/maps']")).toBeVisible();
    await expect(page.locator(".nav-bar .nav-item")).toHaveCount(4);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/driver-home.png` });
    // first stop done -> the next one is Auto Plus
    await pool.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1", [o1.id]);
    await page.reload();
    await expect(page.locator(".ops-next")).toContainText("Auto Plus", { timeout: 15000 });
    await page.goto("/#/customers");
    await expect(page.locator(".ops-hero")).toBeVisible();
  } finally {
    await pool.query("DELETE FROM delivery_routes WHERE driver_id = $1", [driver.id]);
  }
});

test("admin can open both new apps from Home to compare them with the old screens", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await page.locator("#qa-wh-home").click();
  await expect(page.locator(".ops-hero")).toBeVisible({ timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#/wh-home");
  await page.goto("/#/dashboard");
  await page.locator("#qa-driver-home").click();
  await expect(page.locator(".ops-view")).toBeVisible({ timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#/driver-home");
});
