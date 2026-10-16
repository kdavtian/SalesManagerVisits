import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-17: the suggested name of a new customer carries a running number per type + subregion
// ("Tavush / Yuxman ket1", "Tavush / Avtopahestamaser1" ...) so same-type customers can be told apart.
test.describe("New customer name suggestion", () => {
  test("name = area / type word + next free number; follows the type; never overwrites a typed name", async ({ page, fixtures }) => {
    const manager = await fixtures.createUser("sales_manager");
    // two earlier customers of that type in that area: an old unnumbered one and number 2
    for (const name of ["Tavush / Yuxman ket", "Tavush / Yuxman ket2"]) {
      const c = await fixtures.createCustomer({ created_by: manager.id, name });
      expect(c.id).toBeTruthy();
    }
    await loginViaUi(page, manager.email);
    await page.goto("/#/map");
    const mapEl = page.locator("#leaflet-map");
    await expect(mapEl).toBeVisible({ timeout: 10000 });
    const box = await mapEl.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.locator("#location-panel-confirm-btn").click();

    const form = page.locator("#new-customer-form");
    await expect(form).toBeVisible();
    const nameInput = form.locator('input[name="name"]');
    await form.locator("#new-customer-region").selectOption("Tavush");
    await expect(nameInput).toHaveValue("Tavush / Yuxman ket3");

    await form.locator('[data-category="Խանութ"]').click();
    await expect(nameInput).toHaveValue("Tavush / Avtopahestamaser1");
    await form.locator('[data-category="Ավտոսերվիս"]').click();
    await expect(nameInput).toHaveValue("Tavush / Autoservice1");
    await form.locator('[data-category="Այլ"]').click();
    await expect(nameInput).toHaveValue("Tavush / Other1");

    // a name typed by the rep is never replaced
    await nameInput.fill("My own name");
    await form.locator('[data-category="Յուղման կետ"]').click();
    await page.waitForTimeout(400);
    await expect(nameInput).toHaveValue("My own name");
    void pool;
  });
});
