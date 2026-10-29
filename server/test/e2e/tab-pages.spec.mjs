import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-29: "app don't keep pages when navigating 2-3 pages". A tab switch used to throw the left tab's pages away: Customers
// (searched) -> a customer card -> Orders tab -> Customers tab showed a fresh, empty list. Each tab now keeps its pages (shell/tabs.js):
// the same card comes back (the same page, not a rebuilt one), and Back returns to the same searched list.
test("@smoke @iphone a tab comes back with its pages as left: the card, then Back to the searched list", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const tag = `TABKEEP${[...String(Date.now())].map((d) => "abcdefghij"[d]).join("")}`;
  const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: `${tag} Shop`, sales_channel: "SM YVN", erp_customer_id: `${tag}-1` });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  const tab = (hash) => page.locator(`#nav-bar [data-hash="${hash}"]`).first();
  const mark = (name) => page.evaluate((n) => document.querySelector("#app").firstElementChild.setAttribute("data-e2e-mark", n), name);
  const marked = () => page.evaluate(() => document.querySelector("#app").firstElementChild?.getAttribute("data-e2e-mark") ?? null);

  await tab("#/customers").click();
  await page.locator("#customer-search").fill(tag);
  await expect(page.locator("#customer-list .list-row")).toHaveCount(1);
  await mark("list");
  await page.locator("#customer-list .list-row").first().click();
  await expect(page).toHaveURL(new RegExp(`#/customers/${c.id}$`));
  await expect(page.locator("#edit-customer-btn")).toBeVisible();
  await mark("card");

  // to another tab, a page deeper there too
  await tab("#/orders").click();
  await expect(page).toHaveURL(/#\/orders$/);
  await expect(page.locator("#order-status-filters")).toBeVisible();
  await mark("orders");

  // back to Customers: the very same card, then Back -> the very same searched list
  await tab("#/customers").click();
  await expect(page).toHaveURL(new RegExp(`#/customers/${c.id}$`));
  await expect.poll(marked).toBe("card");
  await page.goBack();
  await expect(page).toHaveURL(/#\/customers$/);
  await expect.poll(marked).toBe("list");
  await expect(page.locator("#customer-search")).toHaveValue(tag);

  // and the Orders tab kept its page as well
  await tab("#/orders").click();
  await expect.poll(marked).toBe("orders");
});

// Leaving the Map for a tab whose pages come back keeps the Map as it was (the same map, not rebuilt), and a screen reached without a tab
// tap (an address, a link) still counts as its tab's.
test("the Map is kept when another tab's pages come back; an address typed in counts as its tab", async ({ page, fixtures }) => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==", "base64");
  await page.context().route(/^https:\/\/.*\.png/, (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(1 + Math.floor(Math.random() * 400))]), headers: { "access-control-allow-origin": "*" } })
  );
  const rep = await fixtures.createUser("sales_manager");
  const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, sales_channel: "SM YVN" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, rep.email);
  const tab = (hash) => page.locator(`#nav-bar [data-hash="${hash}"]`).first();

  await page.evaluate((id) => (location.hash = `#/customers/${id}`), c.id); // not a tab tap
  await expect(page.locator("#edit-customer-btn")).toBeVisible();
  await tab("#/map").click();
  await expect(page.locator("#leaflet-map")).toBeVisible();
  await page.evaluate(() => (window.__keptMap = document.querySelector("#leaflet-map")));
  await tab("#/customers").click();
  await expect(page).toHaveURL(new RegExp(`#/customers/${c.id}$`));
  await expect(page.locator("#leaflet-map")).toHaveCount(0);
  await tab("#/map").click();
  await expect(page.locator("#leaflet-map")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("#leaflet-map") === window.__keptMap)).toBe(true);
});
