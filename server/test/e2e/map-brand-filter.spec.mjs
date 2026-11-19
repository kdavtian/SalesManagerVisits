import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-19: "fix the brand filters everywhere including map". The map's Brands filter offers the live competitor list (a brand a
// rep added and an admin approved shows with its own name), and a competitor a visit marked "not available" is a red dot, not a grey one.
test("map Brands filter: an added brand is offered by its name; not available is red", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const tag = `e2ebrand${Date.now()}`;
  const { rows: [brand] } = await pool.query("INSERT INTO competitor_brands (key, name, status, sort_order) VALUES ($1, $2, 'approved', 998) RETURNING id", [tag, "E2E-ENEOS"]);
  try {
    const a = await fixtures.createCustomer({ created_by: rep.id, name: "E2E Brand Shop A", lat: 40.1851, lng: 44.5201 });
    const b = await fixtures.createCustomer({ created_by: rep.id, name: "E2E Brand Shop B", lat: 40.1871, lng: 44.5221 });
    const visit = async (customerId, status) => {
      const { rows: [c] } = await pool.query(
        "INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, brand_status) VALUES ($1, $2, now(), 40.18, 44.52, 3, true, $3) RETURNING id",
        [customerId, rep.id, JSON.stringify(status)]
      );
      fixtures.trackRow("checkins", c.id);
    };
    await visit(a.id, { competitors: [tag], competitor_packs: { [tag]: ["bottle"], mobil: ["none"] } });
    await visit(b.id, { competitors: ["mobil"], competitor_packs: { mobil: ["drum"] } });

    await loginViaUi(page, admin.email);
    await page.goto(`/#/map?customer=${a.id}`);
    await expect(page.locator("#leaflet-map .leaflet-marker-icon").first()).toBeVisible({ timeout: 20000 });
    await page.locator(".map-primary-filter-wrap .activity-search-filter-btn").click();
    await page.locator('.map-filter-chip[data-filter="brands"]').click();

    const picker = page.locator("#brand-picker-row");
    const added = picker.locator(`.brand-picker-chip[data-brand="competitor:${tag}"]`);
    await expect(added).toHaveText("E2E-ENEOS", { timeout: 10000 });
    // the built-in brands stay, KAD brands first
    await expect(picker.locator(".brand-picker-chip").first()).toHaveAttribute("data-brand", "castrol");
    await expect(picker.locator('.brand-picker-chip[data-brand="competitor:mobil"]')).toHaveCount(1);

    await added.click();
    await expect(page.locator("#leaflet-map .brand-dot-available")).toHaveCount(1, { timeout: 10000 });

    // Mobil: shop B has a drum (green), shop A said not available (red)
    await picker.locator('.brand-picker-chip[data-brand="competitor:mobil"]').click();
    await expect(page.locator("#leaflet-map .brand-dot-available")).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator("#leaflet-map .brand-dot-unavailable")).toHaveCount(1);
  } finally {
    await pool.query("DELETE FROM competitor_brands WHERE id = $1", [brand.id]);
  }
});
