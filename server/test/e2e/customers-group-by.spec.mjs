import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: Region filter sheet: Clear / Show floating at the bottom, a "Group by" toggle on the heading's right (the Customers list then
// shows a region header and a subregion header per group); Route plans: a red badge with the number of customers that are on no weekday.
test("region sheet: floating buttons + Group by groups the Customers list by region and subregion", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const mk = async (name, region, subregion) => {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name, sales_channel: "SM YVN" });
    await pool.query("UPDATE customers SET region = $2, subregion = $3 WHERE id = $1", [c.id, region, subregion]);
  };
  await mk("E2E GB Zed One", "Yerevan", "Ajapnyak");
  await mk("E2E GB Alpha Two", "Yerevan", "Kentron");
  await mk("E2E GB Beta Three", "Yerevan", "Ajapnyak");
  await mk("E2E GB Gamma Four", "Kotayk", "Abovyan");
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/customers");
  await expect(page.locator(".list-row", { hasText: "E2E GB Zed One" })).toBeVisible({ timeout: 15000 });
  await page.locator('[data-filter-btn="region"]').click();
  const actions = page.locator("#tree-sheet-done").locator("xpath=..");
  await expect(actions).toHaveClass(/sheet-actions-floating/);
  expect(await actions.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  const toggle = page.locator("#tree-sheet-groupby");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/gb-sheet.png` });
  await page.locator("#tree-sheet-done").click();
  await expect(page.locator(".cl-group-region").first()).toBeVisible({ timeout: 10000 });
  const regions = await page.locator(".cl-group-region").allInnerTexts();
  expect(regions.length).toBeGreaterThanOrEqual(2);
  // inside Yerevan the two Ajapnyak customers sit under one subregion header
  const body = await page.locator("#customer-list").innerText().catch(async () => page.locator(".list-view").innerText());
  expect(body.indexOf("E2E GB Zed One")).toBeLessThan(body.indexOf("E2E GB Alpha Two"));
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/gb-list.png` });
  // switching it off again removes the headers
  await page.locator('[data-filter-btn="region"]').click();
  await page.locator("#tree-sheet-groupby").click();
  await page.locator("#tree-sheet-done").click();
  await expect(page.locator(".cl-group")).toHaveCount(0);
});

test("route plans: the red badge counts customers that are on no weekday", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Badge Rep" });
  for (const n of ["E2E Badge One", "E2E Badge Two"]) await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: n, sales_channel: "SM YVN" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/route-plans");
  const card = page.locator(".route-plan-rep-card", { hasText: "E2E Badge Rep" });
  await expect(card.locator(".route-plan-unplanned-badge")).toHaveText("2", { timeout: 15000 });
  await card.locator(".route-plan-view-customers-btn").click();
  await expect(page.locator("#route-plan-customers-summary")).toContainText("2", { timeout: 10000 });
});

// Owner, 2026-10-24 (ideas 2 and 3): the Group by choice is remembered; tapping a region / subregion header folds its customers.
test("Group by is remembered and a tapped group header folds its customers", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const mk = async (name, region, subregion) => {
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name, sales_channel: "SM YVN" });
    await pool.query("UPDATE customers SET region = $2, subregion = $3 WHERE id = $1", [c.id, region, subregion]);
  };
  await mk("E2E GF Zed One", "Yerevan", "Ajapnyak");
  await mk("E2E GF Alpha Two", "Yerevan", "Kentron");
  await mk("E2E GF Gamma Four", "Kotayk", "Abovyan");
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/customers");
  await expect(page.locator(".list-row", { hasText: "E2E GF Zed One" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".cl-group")).toHaveCount(0);
  await page.locator('[data-filter-btn="region"]').click();
  await page.locator("#tree-sheet-groupby").click();
  await page.locator("#tree-sheet-done").click();
  await expect(page.locator(".cl-group-region").first()).toBeVisible({ timeout: 10000 });
  // remembered: after a full reload the list is grouped without opening the sheet
  await page.reload();
  await expect(page.locator(".list-row", { hasText: "E2E GF Zed One" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".cl-group-region").first()).toBeVisible();
  // fold one subregion: only its customer leaves the list
  const sub = page.locator('.cl-group-sub[data-gkey="s:Yerevan::Ajapnyak"]');
  await expect(sub).toHaveAttribute("aria-expanded", "true");
  const h = await sub.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(43);
  await sub.click();
  await expect(sub).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".list-row", { hasText: "E2E GF Zed One" })).toHaveCount(0);
  await expect(page.locator(".list-row", { hasText: "E2E GF Alpha Two" })).toBeVisible();
  // fold the whole region: every Yerevan customer and its subregion headers leave, the other region stays
  const region = page.locator('.cl-group-region[data-gkey="r:Yerevan"]');
  await region.click();
  await expect(page.locator(".list-row", { hasText: "E2E GF Alpha Two" })).toHaveCount(0);
  await expect(page.locator('.cl-group-sub[data-gkey="s:Yerevan::Kentron"]')).toHaveCount(0);
  await expect(page.locator(".list-row", { hasText: "E2E GF Gamma Four" })).toBeVisible();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/gb-folded.png` });
  // unfold the region: the subregion that was folded stays folded
  await region.click();
  await expect(page.locator(".list-row", { hasText: "E2E GF Alpha Two" })).toBeVisible();
  await expect(page.locator(".list-row", { hasText: "E2E GF Zed One" })).toHaveCount(0);
  // Enter on a focused header folds too
  await region.focus();
  await page.keyboard.press("Enter");
  await expect(region).toHaveAttribute("aria-expanded", "false");
});

test("route plans: tapping the red number lists only the customers on no day; the button switches to all", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Tap Rep" });
  for (const n of ["E2E Tap One", "E2E Tap Two", "E2E Tap Rival"]) {
    const c = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name: n, sales_channel: "SM YVN" });
    if (n.endsWith("Rival")) await pool.query("UPDATE customers SET customer_tier = 'competitor' WHERE id = $1", [c.id]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/route-plans");
  const card = page.locator(".route-plan-rep-card", { hasText: "E2E Tap Rep" });
  const badge = card.locator(".route-plan-unplanned-badge");
  await expect(badge).toHaveText("2", { timeout: 15000 });
  // the badge itself: only the unplanned customers, groups already open
  await badge.click();
  await expect(page.locator("#route-plan-customers-summary")).toContainText("2", { timeout: 10000 });
  await expect(page.locator("#route-plan-customers-tree").getByText("E2E Tap One")).toBeVisible();
  await expect(page.getByText("E2E Tap Rival")).toHaveCount(0);
  const toggle = page.locator("#route-plan-customers-toggle");
  await expect(toggle).toBeVisible();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/plan-unplanned.png` });
  await toggle.click();
  await expect(page.getByText("E2E Tap Rival")).toBeVisible();
  await page.locator("#close-route-plan-customers").click();
  // the rest of the button opens the full list
  await card.locator(".route-plan-view-customers-btn").click({ position: { x: 20, y: 10 } });
  await expect(page.locator("#route-plan-customers-toggle")).toContainText(/only/i, { timeout: 10000 });
});
