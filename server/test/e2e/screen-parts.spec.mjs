import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// What the last "enhancer" scripts did from outside, now done by the screens themselves (docs/architecture-roadmap.md step 7b):
// the Map's Competitors chip, the new-customer form for a sales manager, Armenian region names on the plan-day sheet, Activity's
// date fields, and competitors kept out of the visit queues (api.js).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const tiles = (page) => page.route(/\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));

test.describe("Screens build their own parts", () => {
  test("@smoke Map: the Competitors chip is there on a cold start and keeps its own icon after a filter is picked", async ({ page, fixtures }) => {
    await tiles(page);
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/map");
    await page.reload(); // straight into the Map: the old mount gave up after 1 s of retries
    const chip = page.locator(".map-competitor-toggle");
    await expect(chip).toHaveCount(1, { timeout: 10000 });
    const shopIcon = await chip.locator(".map-filter-chip-icon").innerHTML();

    await page.locator(".map-primary-filter-wrap .activity-search-filter-btn").click();
    await page.locator('.map-filter-chip[data-filter="overdue"]').click();
    await expect(chip.locator(".map-filter-chip-icon")).toHaveJSProperty("innerHTML", shopIcon);

    await expect(page.locator(".map-view")).not.toHaveClass(/kad-show-competitors/);
    await chip.evaluate((el) => el.click());
    await expect(page.locator(".map-view")).toHaveClass(/kad-show-competitors/);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  test("New customer: the business-name label, and a sales manager's channel preset and hidden", async ({ page, fixtures }) => {
    await tiles(page);
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: 40.18, longitude: 44.51 });
    await page.route(/\/api\/geocode\/reverse/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ address: "Test 1", region: "Yerevan" }) }));
    const rep = await fixtures.createUser("sales_manager", { name: "Rep SM YVN" });
    await pool.query("UPDATE users SET position = 'SM YVN' WHERE id = $1", [rep.id]);
    await loginViaUi(page, rep.email);
    await page.goto("/#/map?add=1");
    const box = await page.locator("#leaflet-map").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator("#location-panel-confirm-btn").click();
    const form = page.locator("#new-customer-form");
    await expect(form).toBeVisible();
    await expect(form.locator('label:has(input[name="name"])')).toContainText("Անվանում");
    await expect(form.locator("#new-customer-channel")).toHaveValue("SM YVN");
    await expect(form.locator('label:has(#new-customer-channel)')).toBeHidden();
  });

  test("Plan day (recurring): region names in Armenian", async ({ page, fixtures }) => {
    await tiles(page);
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const rep = await fixtures.createUser("sales_manager");
    const c = await fixtures.createCustomer({ name: "Plan Arabkir", created_by: rep.id, sales_channel: "SM YVN", erp_customer_id: `PA-${Date.now()}` });
    await pool.query("UPDATE customers SET region = 'Yerevan', subregion = 'Arabkir' WHERE id = $1", [c.id]);
    for (let d = 0; d < 7; d++) {
      await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, areas, created_by) VALUES ($1, $2, $3, $1) ON CONFLICT DO NOTHING", [rep.id, d, JSON.stringify([{ region: "Yerevan", subregion: "Arabkir" }])]);
    }
    await loginViaUi(page, rep.email);
    await page.goto("/#/map");
    await page.locator("#plan-day-btn").evaluate((el) => el.click());
    await page.locator('body > .sheet-overlay [data-mode="recurring"]').click();
    await expect(page.locator(".plan-area-row span").first()).toHaveText("Երևան · Արաբկիր");
    await expect(page.locator('#plan-add-region option[value="Yerevan"]')).toHaveText("Երևան");
  });

  test("Activity: the custom range's dates open the wheel picker", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/activity");
    await page.locator('[data-range="custom"], .activity-tab').last().click();
    const fields = page.locator(".activity-custom-range .activity-date-field");
    await expect(fields).toHaveCount(2);
    await fields.first().click();
    await expect(page.locator(".activity-date-picker-overlay")).toBeVisible(); // a wheel on a phone, a date box on a desktop
  });

  test("Competitors are never in the overdue queue and never due", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const comp = await fixtures.createCustomer({ name: `Comp ${Date.now()}`, created_by: admin.id, sales_channel: "SM YVN" });
    await pool.query("UPDATE customers SET customer_tier = 'competitor' WHERE id = $1", [comp.id]);
    await loginViaUi(page, admin.email);
    const result = await page.evaluate(async (id) => {
      const { api } = await import("/js/api.js");
      const overdue = await api.listCustomers({ visited: "overdue" });
      const one = await api.getCustomer(id);
      return { inQueue: overdue.some((c) => c.id === id), overdue: one.overdue, required: one.visit_required, channel: one.sales_channel };
    }, comp.id);
    expect(result).toEqual({ inQueue: false, overdue: false, required: false, channel: "COMPETITORS" });
  });
});
