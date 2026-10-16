import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17: map search = Customers / Addresses tabs with counts, and customers are found by phone number too.
test.describe("Map search tabs + phone", () => {
  test("tabs with counts; phone digits (any format) find the customer", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const stamp = Date.now();
    const a = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, sales_channel: "SM YVN", name: `Tabtest Phone Garage ${stamp}`, erp_customer_id: `TT-${stamp}-1` });
    await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, sales_channel: "SM YVN", name: `Tabtest Other ${stamp}`, erp_customer_id: `TT-${stamp}-2`, lat: 40.19, lng: 44.52 });
    await pool.query("UPDATE customers SET phone = '+37491007019' WHERE id = $1", [a.id]);

    // the geocoder and map tiles are external: mock them (tiles of varying size, or the map's soft-block detector trips)
    let tileN = 0;
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.route(/\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(++tileN)]) }));
    await page.route("**/api/geocode/search**", (r) => r.fulfill({ json: [{ address: `Tabtest street 1, Yerevan`, lat: 40.18, lng: 44.5 }, { address: `Tabtest street 2, Yerevan`, lat: 40.181, lng: 44.5 }] }));

    await loginViaUi(page, admin.email);
    await page.goto("/#/map");
    const input = page.locator("#map-customer-search");
    await expect(input).toBeVisible({ timeout: 15000 });

    await input.fill("Tabtest");
    const tabs = page.locator(".map-sr-tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toContainText("2"); // 2 customers
    await expect(tabs.nth(1)).toContainText("2"); // 2 addresses
    await expect(page.locator(".map-sr-row[data-cid]")).toHaveCount(2);
    await tabs.nth(1).click();
    await expect(page.locator(".map-sr-row[data-aidx]")).toHaveCount(2);
    await expect(page.locator(".map-sr-row[data-cid]")).toHaveCount(0);

    // phone, typed the way people write it
    for (const typed of ["091 007 019", "+374 91 007019", "91007"]) {
      await input.fill(typed);
      await expect(page.locator(".map-sr-row[data-cid]")).toHaveCount(1, { timeout: 5000 });
      await expect(page.locator(".map-sr-row[data-cid]")).toContainText("+37491007019");
      await expect(page.locator(".map-sr-row[data-cid]")).toContainText("Tabtest Phone Garage");
    }
  });
});
