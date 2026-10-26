import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-26: six visit outcomes, "Other" needs a note, one "KAD products" card (Castrol | Lotos + Royal) and the longer competitors list.
test.use({ geolocation: { latitude: 40.18, longitude: 44.51, accuracy: 10 }, permissions: ["geolocation"] });

test("check-in outcomes, note for Other, KAD products and competitors sheets", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/checkin/${customer.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });

  // exactly these six, in this order
  const values = await page.locator(".outcome-chip input").evaluateAll((els) => els.map((e) => e.value));
  expect(values).toEqual(["order_placed", "follow_up_required", "payment_collected", "assortment_check", "customer_unavailable", "other"]);

  // Other without a note is refused on the spot; with a note it goes through
  await page.locator('label.outcome-chip:has(input[value="other"])').click();
  await expect(page.locator("#note-label")).toContainText("required");
  await page.locator("#checkin-submit").click();
  await expect(page.locator("#note-error")).toBeVisible();
  await page.locator('textarea[name="note"]').fill("Shop was closed, will return");
  await expect(page.locator("#note-error")).toBeHidden();

  // Products found: two cards only
  await expect(page.locator("[data-brand-card]")).toHaveCount(2);
  await page.locator('[data-brand-card="kad"]').click();
  const sheet = page.locator(".brand-sheet-kad");
  await expect(sheet.locator(".brand-sheet-col")).toHaveCount(2);
  await expect(sheet.locator(".brand-sheet-col").first().locator('[data-sheet-group="castrol"]')).toBeVisible();
  const right = sheet.locator(".brand-sheet-col").nth(1);
  await expect(right.locator('[data-sheet-group="lotos"]')).toBeVisible();
  await expect(right.locator('[data-sheet-group="royal"]')).toBeVisible();
  // Lotos and Royal are separate: ticking Lotos "Full range" does not touch Royal
  await right.locator('[data-sheet-group="lotos"] label:has(input[value="full_range"])').click();
  await expect(right.locator('[data-sheet-group="lotos"] input[value="available"]')).toBeChecked();
  await expect(right.locator('[data-sheet-group="royal"] input[value="available"]')).not.toBeChecked();
  await sheet.locator("#brand-sheet-done").click();
  await expect(page.locator('[data-brand-card="kad"]')).toHaveClass(/brand-group-btn-active/);
  await expect(page.locator('[data-brand-card="kad"]')).toContainText("(2)"); // Lotos: Available + Full range

  await page.locator('[data-brand-card="competitors"]').click();
  const names = await page.locator(".brand-sheet-competitors .brand-chip span").allTextContents();
  expect(names).toEqual([
    "Mobil", "Motul", "Shell", "LiquiMoly", "Aral", "Bardahl", "Petronas", "Fuchs", "Total",
    "Ravenol", "Oscar", "AMSoil", "Zic", "Pennzoil", "Addinol", "S-Oil", "Kixx", "Russian oil",
  ]);
  await page.locator('.brand-sheet-competitors [data-action="close-sheet"]').click();

  // Take photo is a wide button; High resolution sits at the left edge under it
  const camera = await page.locator("#camera-btn").boundingBox();
  expect(camera.width).toBeGreaterThan(300);
  expect(camera.height).toBeGreaterThanOrEqual(56);
  const toggle = await page.locator(".high-res-photo-toggle").boundingBox();
  expect(toggle.x).toBeLessThan(camera.x + 24);

  const [response] = await Promise.all([page.waitForResponse((res) => res.url().includes("/api/checkins") && res.request().method() === "POST"), page.locator("#checkin-submit").click()]);
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  fixtures.trackRow("checkins", created.id);
  expect(created.outcomes).toEqual(["other"]);
});
