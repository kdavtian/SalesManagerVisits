import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-25: the potential level is not asked when a customer is added; it is asked at the visit (check-in screen), with two new reasons.
test.use({ viewport: { width: 440, height: 956 }, geolocation: { latitude: 40.185, longitude: 44.52, accuracy: 15 }, permissions: ["geolocation"] });

test("check-in shows the Potential section for a potential customer; the two visit reasons are one tap away", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: "E2E Visit Potential Shop", sales_channel: "SM YVN" });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/checkin/${c.id}`);
  const card = page.locator("#checkin-potential .pl-card");
  await expect(card).toContainText("Not assessed", { timeout: 15000 });
  await card.locator("[data-pl-edit]").click();
  await page.locator('.pl-level-chip[data-level="3"]').click();
  // the two things a rep does at a first visit are visible without "More reasons"
  await expect(page.locator('.pl-reason-chip[data-reason="gave_price_list"]')).toContainText("I gave the price list");
  await expect(page.locator('.pl-reason-chip[data-reason="introduced_products"]')).toContainText("I introduced the products");
  await page.locator('.pl-reason-chip[data-reason="gave_price_list"]').click();
  await page.locator('.pl-reason-chip[data-reason="introduced_products"]').click();
  await page.locator('#pl-form button[type="submit"]').click();
  await expect(card.locator(".pl-chip")).toContainText("Real potential", { timeout: 10000 });
  await expect(card).toContainText("I gave the price list");
  const { rows } = await pool.query("SELECT potential_level, potential_reasons FROM customers WHERE id = $1", [c.id]);
  expect(rows[0].potential_level).toBe(3);
  expect([...rows[0].potential_reasons].sort()).toEqual(["gave_price_list", "introduced_products"]);
});
