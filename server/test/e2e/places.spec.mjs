import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: region / subregion typed as free text on the customer card are matched to the Armenian places; what cannot be placed is flagged for review.
test("customer card: a misspelt subregion is corrected, an unknown one is kept and shows up in Places to review", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Places Customer" });
  await pool.query("UPDATE customers SET region = 'Shirak', subregion = NULL WHERE id = $1", [c.id]);
  try {
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${c.id}`);
    await page.locator("#account-settings-btn").click();
    const sub = page.locator("#reassign-subregion");
    await expect(sub).toBeVisible();
    // suggestions while typing (datalist)
    await sub.fill("gyu");
    await expect(page.locator("#reassign-subregion-list option[value='Gyumri']")).toHaveCount(1);
    await sub.fill("Gumri");
    await page.locator('#account-settings-form button[type="submit"]').click();
    await expect(page.locator(".app-toast")).toContainText("Saved as: Gyumri");
    await expect.poll(async () => (await pool.query("SELECT subregion FROM customers WHERE id = $1", [c.id])).rows[0].subregion).toBe("Gyumri");

    // a text that is not a place stays as typed and is queued
    await page.locator("#account-settings-btn").click();
    await page.locator("#reassign-subregion").fill("Zzyzx Qwerty");
    await page.locator('#account-settings-form button[type="submit"]').click();
    await expect(page.locator(".app-toast")).toContainText("not in the list of Armenian places");
    await expect(page.locator(".badge-warning", { hasText: "to review" })).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await pool.query("SELECT subregion FROM customers WHERE id = $1", [c.id])).rows[0].subregion).toBe("Zzyzx Qwerty");

    // the admin sees it in Settings -> Administration -> Places
    await page.goto("/#/settings");
    await page.locator("#settings-admin-tab").click();
    await page.locator('[data-nav-page="a-system"]').click();
    await page.locator("#row-places").click();
    const card = page.locator("#places-review .card", { hasText: "E2E Places Customer" });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText("Zzyzx Qwerty");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/places-review.png` });
    await card.locator("[data-act='dismiss']").click();
    await expect(card).toHaveCount(0, { timeout: 10000 });
  } finally {
    await pool.query("DELETE FROM place_reviews WHERE customer_id = $1", [c.id]);
  }
});

// A stored English place name reads in Armenian when the app is in Armenian, and a name saved in Armenian letters reads in English when the app is in English.
test("customer card shows places in the language of the app", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: "E2E Places Lang Customer" });
  await pool.query("UPDATE customers SET region = 'Shirak', subregion = 'Gyumri' WHERE id = $1", [c.id]);
  await loginViaUi(page, admin.email);
  await page.goto(`/#/customers/${c.id}`);
  await expect(page.locator(".detail-fact", { hasText: "Gyumri" })).toBeVisible({ timeout: 15000 });
  // Armenian letters saved by an old version / the geocoder: shown in English while the app is in English
  await pool.query("UPDATE customers SET subregion = 'Գյումրի' WHERE id = $1", [c.id]);
  await page.reload();
  await expect(page.locator(".detail-fact", { hasText: "Gyumri" })).toBeVisible({ timeout: 15000 });
  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy")); // runs after the fixture's own English one
  await pool.query("UPDATE customers SET subregion = 'Gyumri' WHERE id = $1", [c.id]);
  await page.reload();
  await expect(page.locator(".detail-fact", { hasText: "Գյումրի" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".detail-fact", { hasText: "Շիրակ" })).toBeVisible();
});
