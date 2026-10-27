import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 7: on a desktop window management's Home shows the five numbers in one row, and under them
// "Needs attention" (each row a link to the page where it is dealt with) beside "Today" (the field team's plan vs visits and
// today's visits on a small map). A phone keeps its own Home without any of it.
test("desktop Home: KPI row, Needs attention and Today side by side", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager", { name: `HomeRep${stamp}` });
  const shop = await fixtures.createCustomer({ name: `HomeShop${stamp}`, created_by: admin.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const { rows } = await pool.query(
    "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.51, 3, true) RETURNING id",
    [shop.id, rep.id]
  );
  fixtures.trackRow("checkins", rows[0].id);

  await loginViaUi(page, admin.email);
  await page.goto("/#/dashboard");
  const kpis = page.locator("#home-kpis");
  await expect(kpis.locator(".home-kpi")).toHaveCount(5, { timeout: 15000 });

  // the five tiles share one row
  const tops = await kpis.locator(".home-kpi").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);

  // Needs attention: four link rows; Today beside it
  const att = kpis.locator(".home-attention");
  await expect(att.locator(".home-att-row")).toHaveCount(4);
  await expect(att.locator(".home-att-row").first()).toHaveAttribute("href", "#/orders");
  const today = kpis.locator(".home-today");
  await expect(today).toBeVisible();
  const [a, b] = await Promise.all([att.boundingBox(), today.boundingBox()]);
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.x).toBeGreaterThan(a.x + a.width - 1);

  // the rep who visited today, with 1 visit, and the visit on the map
  const repRow = today.locator(".home-rep-row", { hasText: `HomeRep${stamp}` });
  await expect(repRow).toBeVisible({ timeout: 15000 });
  await expect(repRow.locator(".home-rep-num")).toContainText("1");
  await expect(today.locator(".home-today-map-canvas .leaflet-interactive").first()).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-home.png` });

  // a row opens its page
  await att.locator('.home-att-row[href="#/tasks"]').click();
  await expect(page).toHaveURL(/#\/tasks$/);

  // back on Home the Today block is there again (kept across repaints), the map included
  await page.goto("/#/dashboard");
  await expect(page.locator("#home-kpis .home-today .home-rep-row", { hasText: `HomeRep${stamp}` })).toBeVisible({ timeout: 15000 });

  // phone: no KPI block, no columns
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/activity");
  await page.goto("/#/dashboard");
  await expect(page.locator(".quick-actions-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#home-kpis")).toBeHidden();
});
