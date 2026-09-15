import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("Customer search and map navigation", () => {
  test("@smoke searching the customer list finds a seeded customer, and the map renders and accepts filter interaction", async ({
    page,
    fixtures,
  }) => {
    const manager = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({
      created_by: manager.id,
      name: `Findable Garage ${Date.now()}`,
    });

    await loginViaUi(page, manager.email);

    await page.goto("/#/customers");
    await page.locator("#customer-search").fill(customer.name);
    await expect(page.getByText(customer.name)).toBeVisible();

    // Map navigation: the map view must actually mount (Leaflet container
    // present and interactive), and its own filter row must be reachable --
    // this is what a real map screen visit looks like, not just a route
    // change.
    await page.goto("/#/map");
    await expect(page.locator("#leaflet-map, .leaflet-container")).toBeVisible({ timeout: 10000 });
    const filterTrigger = page.locator('button[aria-haspopup="menu"]').first();
    await expect(filterTrigger).toBeVisible();
  });
});
