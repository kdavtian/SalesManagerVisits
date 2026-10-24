import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner report (2026-10-16): after adding a customer the map kept saying "Tap the map to place a pin" (taps did
// nothing) and the new pin was missing; after changing a customer's location, Back showed the change-location page
// again. These drive the real flows in a real browser.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

const mapState = (page) =>
  page.evaluate(() => ({
    hash: location.hash,
    hintVisible: (() => {
      const h = document.querySelector("#map-hint");
      return h ? !h.hidden : null;
    })(),
    panelOpen: (() => {
      const x = document.querySelector("#location-picker-panel");
      return x ? !x.hidden : null;
    })(),
    relocateBar: Boolean(document.querySelector("#cancel-relocate")),
    popup: document.querySelector(".leaflet-popup-content")?.innerText ?? null,
  }));

test.describe("Map: add and relocate a customer", () => {
  test("@smoke adding a customer ends the add flow cleanly: no stale hint, the new pin is shown, Back does not reopen add mode", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    const rep = await fixtures.createUser("sales_manager");
    await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Neighbour Shop", lat: 40.1812, lng: 44.5136 });
    await loginViaUi(page, rep.email);

    await page.goto("/#/map?add=1");
    await expect(page.locator("#location-panel-confirm-btn")).toBeVisible({ timeout: 20000 });
    expect((await mapState(page)).hintVisible).toBe(false); // a pin is placed: nothing left to tap

    await page.locator("#location-panel-confirm-btn").click();
    await page.locator('#new-customer-form input[name="name"]').fill("E2E Brand New Shop");
    await page.locator('#new-customer-form .pl-level-btn[data-level="3"]').click();
    await page.locator('#new-customer-form .pl-reason-chip[data-reason="active_interest"]').click();
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith("/api/customers") && res.request().method() === "POST"),
      page.locator('#new-customer-form button[type="submit"]').click(),
    ]);
    const created = await response.json();
    fixtures.track("customers", created.id);
    await expect(page.locator("#new-customer-form")).toBeHidden();

    // the pin of the new customer is on the map with its popup open
    await expect(page.locator(".leaflet-popup-content")).toContainText("E2E Brand New Shop", { timeout: 10000 });
    const after = await mapState(page);
    expect(after.hintVisible).toBe(false);
    expect(after.hash).toBe(`#/map?customer=${created.id}`);

    // customer card and Back: the map is just a map, not add mode again
    await page.goto(`/#/customers/${created.id}`);
    await expect(page.locator("#edit-customer-btn")).toBeVisible();
    await page.goBack();
    await page.waitForTimeout(800);
    const back = await mapState(page);
    expect(back.hintVisible).toBe(false);
    expect(back.panelOpen).not.toBe(true);
  });

  test("@smoke changing a customer's location: the Map's cached list follows, and Back never shows the change-location page again", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Relocate Shop", lat: 40.1812, lng: 44.5136 });
    await loginViaUi(page, rep.email);

    await page.goto(`/#/customers/${customer.id}`);
    await page.locator("#edit-customer-btn").click();
    await page.locator("#change-location-btn").click();
    await expect(page.locator("#location-panel-confirm-btn")).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2500); // the flow places its own start pin first
    // a map tap somewhere else moves the pin
    await page.evaluate(() => {
      const el = document.querySelector("#leaflet-map");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.35, bubbles: true, cancelable: true, view: window }));
    });
    await page.locator("#location-panel-confirm-btn").click();
    await page.locator("#save-relocate").click();
    await expect(page).toHaveURL(new RegExp(`#/customers/${customer.id}$`));

    const { rows } = await pool.query("SELECT lat, lng FROM customers WHERE id = $1", [customer.id]);
    expect(Math.abs(rows[0].lat - 40.1812) + Math.abs(rows[0].lng - 44.5136)).toBeGreaterThan(1e-5);
    // the Map tab's own cached copy carries the new spot (it used to keep the old one until a refetch)
    const cached = await page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const req = indexedDB.open("fieldvisits_list_cache", 1);
          req.onsuccess = () => {
            const store = req.result.transaction("responses", "readonly").objectStore("responses");
            const keys = store.getAllKeys();
            keys.onsuccess = () => {
              const key = keys.result.find((k) => String(k).endsWith(":map-customers"));
              if (!key) return resolve("no-cache");
              const g = req.result.transaction("responses", "readonly").objectStore("responses").get(key);
              g.onsuccess = () => resolve((g.result || []).find((c) => c.id === id) ?? "absent");
            };
          };
          req.onerror = () => resolve("idb-error");
        }),
      customer.id
    );
    if (cached !== "no-cache") expect(Math.abs(cached.lat - rows[0].lat)).toBeLessThan(1e-6);

    await page.goBack();
    await page.waitForTimeout(800);
    const back = await mapState(page);
    expect(back.relocateBar).toBe(false);
    expect(back.panelOpen).not.toBe(true);
    expect(back.hash).not.toContain("relocate");
  });
});
