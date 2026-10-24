import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Review screenshots of the desktop layouts (owner, 2026-10-24: "desktop version ONLY ... go to every page, check and improve").
// Only runs when DESKTOP_SHOTS names a folder; it also asserts the desktop Debt balances columns.
const SHOTS = process.env.DESKTOP_SHOTS;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });
let tileNo = 0;

test("desktop review", async ({ page, fixtures }) => {
  test.skip(!SHOTS, "set DESKTOP_SHOTS to take them");
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Aram Rep" });
  const stamp = Date.now();
  const made = [];
  const mk = async (i, debt, ageDays, paid) => {
    const erpId = `E2E-DESK-${stamp}-${i}`;
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `E2E Desk Customer ${i} Autoservice`, sales_channel: "SM YVN", lat: 40.185 + i * 0.001, lng: 44.52 + i * 0.001, erp_customer_id: erpId });
    await pool.query("UPDATE customers SET customer_tier = $2 WHERE id = $1", [c.id, i % 2 ? "gold" : "silver"]);
    await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, last_payment_date, synced_at) VALUES ($1, $2, $3, 0, current_date - $4::int, now())", [erpId, c.name, debt, paid]);
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, 'O1', current_date - $2::int, $3), ($1, 'O0', current_date - 200, 400000)", [erpId, ageDays, debt]);
    await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, current_date - $2::int, $3)", [erpId, paid, Math.round(debt / 3)]);
    made.push(erpId);
    return c;
  };
  const c1 = await mk(1, 2420000, 94, 30);
  await mk(2, 800000, 20, 5);
  await mk(3, 1500000, 60, 45);
  await mk(4, 300000, 130, 90);
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/debt-balances");
    await expect(page.locator(".debt-desk-row").first()).toBeVisible({ timeout: 20000 });
    // the columns of the desktop table and the aging categories
    for (const label of ["Last payment", "Last order", "Last visit", "Category", "Debt / orders"]) await expect(page.locator(".desk-thead-debt, .debt-desk-list .desk-thead").first()).toContainText(new RegExp(label, "i"));
    const row = page.locator(".debt-desk-row", { hasText: "Desk Customer 1" });
    await expect(row).toContainText("2,420,000");
    await expect(row).toContainText(/%/); // debt as a share of the last 12 months of orders
    await expect(page.locator(".debt-desk-bucket").first()).toBeVisible();
    // an aging category filters the table; tapping it again clears it
    await page.locator('[data-bucket="d61_90"]').click();
    await expect(page.locator(".debt-desk-row", { hasText: "Desk Customer 4" })).toBeVisible();
    await expect(page.locator(".debt-desk-row", { hasText: "Desk Customer 2" })).toHaveCount(0);
    await page.locator('[data-bucket="d61_90"]').click();
    // a column heading sorts: the customer name A to Z, then back to the debt
    await page.locator('[data-sort-key="name"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-sort-key="debt"]').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/desk-debt.png` });
    await page.goto(`/#/map?customer=${c1.id}`);
    await expect(page.locator("#leaflet-map .leaflet-marker-icon").first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/desk-map.png` });
    await page.locator("#leaflet-map .leaflet-marker-icon:not(.leaflet-cluster-icon)").first().dispatchEvent("click");
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/desk-map-card.png` });
    await page.goto(`/#/customers/${c1.id}`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/desk-customer.png`, fullPage: true });
    await page.goto("/#/customers");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/desk-customers.png` });
    await page.locator("#toggle-debt-btn").click();
    await page.waitForTimeout(1500);
    await expect(page.locator(".customer-desk-debt-owes").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desk-customers-debt.png` });
  } finally {
    for (const id of made) {
      await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [id]);
      await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [id]);
      await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [id]);
    }
  }
});

// A sweep of the main pages on a desktop window (screenshots only): where does the layout waste space or misalign?
test("desktop sweep", async ({ page, fixtures }) => {
  test.skip(!SHOTS, "set DESKTOP_SHOTS to take them");
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(tileNo++)]) }));
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  for (const route of ["dashboard", "activity", "orders", "tasks", "payments", "reports", "sales", "products", "warehouse", "team-performance", "cashflow", "vaghinak", "notifications", "settings"]) {
    await page.goto(`/#/${route}`);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${SHOTS}/sweep-${route}.png` });
  }
});
