import { test, expect, loginViaUi } from "./fixtures.mjs";

test.describe("New customer creation", () => {
  test("right-clicking the map drops a pin and a new customer can be saved through the form", async ({
    page,
    fixtures,
  }) => {
    const manager = await fixtures.createUser("sales_manager");
    await loginViaUi(page, manager.email);

    await page.goto("/#/map");
    const mapEl = page.locator("#leaflet-map");
    await expect(mapEl).toBeVisible({ timeout: 10000 });

    // Desktop path for dropping a new-customer pin: right-click (map.js's
    // own "contextmenu" handler) anywhere on the map canvas, bypassing the
    // FAB's GPS-fix flow -- deterministic regardless of this machine's own
    // geolocation, and exercises the same openNewCustomerForm() the FAB
    // flow ends at either way.
    const box = await mapEl.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });

    // The right-click first drops a draggable pin and opens a
    // confirm-location panel (showLocationPanel) -- the new-customer form
    // only opens once that placement is confirmed, same as a dragged pin
    // or a searched address would also go through.
    await page.locator("#location-panel-confirm-btn").click();

    const form = page.locator("#new-customer-form");
    await expect(form).toBeVisible();

    const name = `E2E New Customer ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    // Sales channel is deliberately hidden for a sales_manager (see
    // fieldVisitEnhancements.js's enhanceNewCustomerForm) -- it's
    // auto-guessed from the manager's own profile and the server
    // independently resolves/overwrites it at create time as the
    // authority, so a rep never picks it by hand.
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/customers") && res.request().method() === "POST"),
      form.locator('button[type="submit"]').click(),
    ]);
    const created = await response.json();
    fixtures.trackRow("customers", created.id);

    await expect(form).toBeHidden();
    // The freshly-created pin's popup carries the customer's own name --
    // confirms the save actually landed, not just that the form closed.
    // .first() since the same name can also appear in a side-list card at
    // wider viewports (desktop's list+map split) -- either match proves it.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  });
});
