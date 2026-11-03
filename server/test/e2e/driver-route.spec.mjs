import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Driver route (owner, 2026-11-03): one big next stop with Navigate + Delivered, phone and address on one line, the other stops folded away.
const TODAY = "(now() AT TIME ZONE 'Asia/Yerevan')::date";

test("@iphone driver route: one next stop, phone + address on one line, rest folded", async ({ page, fixtures }) => {
  const driver = await fixtures.createUser("delivery_manager");
  const admin = await fixtures.createUser("admin");
  const stops = [];
  for (let i = 1; i <= 3; i++) {
    const c = await fixtures.createCustomer({ created_by: admin.id, name: `E2E Drv Customer ${i} with a rather long name for the phone` });
    await pool.query("UPDATE customers SET phone = '+37491007019', address = 'Yerevan, Some Very Long Street Name 12/3, Apartment 45' WHERE id = $1", [c.id]);
    stops.push(await fixtures.createOrder({ customer_id: c.id, user_id: admin.id, status: "packed_stock_out", total_amd: 10000 * i }));
  }
  const { rows } = await pool.query(`INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, ${TODAY}, $2) RETURNING id`, [driver.id, admin.id]);
  const routeId = rows[0].id;
  try {
    for (const [i, o] of stops.entries()) await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, $3)", [routeId, o.id, i + 1]);
    await loginViaUi(page, driver.email);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#/delivery");
      await page.reload();
      const next = page.locator(".drv-next");
      await expect(next).toBeVisible();
      await expect(next).toContainText("Customer 1");
      const nav = next.locator(".drv-navigate");
      const done = next.locator("[data-open-stop]");
      expect((await nav.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await done.boundingBox()).height).toBeGreaterThanOrEqual(44);
      // phone and address share one line
      const ph = await next.locator(".drv-phone").boundingBox();
      const ad = await next.locator(".drv-address").boundingBox();
      expect(Math.abs(ph.y + ph.height / 2 - (ad.y + ad.height / 2))).toBeLessThan(8);
      // the rest is folded: not visible until the summary is tapped
      await expect(page.locator(".drv-row").first()).toBeHidden();
      await page.locator(".drv-fold > summary").first().click();
      await expect(page.locator(".drv-row").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/driver-${width}.png`, fullPage: true });
    }
    // "Delivered" opens the sheet with signature + payment (only then)
    await page.locator(".drv-next [data-open-stop]").click();
    await expect(page.locator("#signature-canvas")).toBeVisible();
  } finally {
    await pool.query("DELETE FROM delivery_routes WHERE id = $1", [routeId]);
  }
});
