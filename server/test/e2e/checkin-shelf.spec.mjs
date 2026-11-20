import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-20: "I want to have all products infos on shelf". A reminder at a shop's first visit; required when the shop still has no shelf
// data after a visit (or it is 60+ days old), with "Could not check the shelf" + a reason as the way out.
test.use({ geolocation: { latitude: 40.18, longitude: 44.51, accuracy: 10 }, permissions: ["geolocation"] });

test("@smoke shelf: a reminder at the first visit, required afterwards, 'could not check' needs a reason", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const first = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const again = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  await pool.query(
    "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, timestamp) VALUES ($1, $2, 40.18, 44.51, 5, true, ARRAY['no_order'], now() - interval '10 days')",
    [again.id, rep.id]
  );
  await loginViaUi(page, rep.email);

  // the first visit: a reminder, no "could not check", and the visit saves without the shelf
  await page.goto(`/#/checkin/${first.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#shelf-rule")).toBeVisible();
  await expect(page.locator("#shelf-rule")).not.toHaveClass(/shelf-rule-required/);
  await expect(page.locator("#shelf-skip-btn")).toBeHidden();
  await page.screenshot({ path: "test-results/checkin-shelf-nudge.png" });

  // a later visit with no shelf data yet: required
  await page.goto(`/#/checkin/${again.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#shelf-rule")).toHaveClass(/shelf-rule-required/);
  await page.locator('label.outcome-chip:has(input[value="follow_up_required"])').click();
  await page.locator("#checkin-submit").click();
  await expect(page.locator("#shelf-error")).toBeVisible();
  // "could not check": a reason is needed
  await page.locator("#shelf-skip-btn").click();
  await page.locator("#shelf-skip-reason").fill("x");
  await page.locator("#checkin-submit").click();
  await expect(page.locator("#shelf-error")).toBeVisible();
  await page.locator("#shelf-skip-reason").fill("Owner was away");
  await page.screenshot({ path: "test-results/checkin-shelf-required.png" });
  await page.locator("#checkin-submit").click();
  await expect
    .poll(async () => (await pool.query("SELECT brand_status FROM checkins WHERE customer_id = $1 ORDER BY id DESC LIMIT 1", [again.id])).rows[0]?.brand_status?.shelf_skipped?.reason, { timeout: 15000 })
    .toBe("Owner was away");

  // ticking a shelf product hides the rule (the first shop: the same shop cannot be checked in twice in a row)
  await page.goto(`/#/checkin/${first.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#shelf-rule")).toBeVisible();
  await page.locator('[data-brand-card="kad"]').click();
  await page.locator('.brand-sheet-kad [data-sheet-group="castrol"] label:has(input[value="available"])').click();
  await page.locator(".brand-sheet-kad #brand-sheet-done").click();
  await expect(page.locator("#shelf-rule")).toBeHidden();
});
