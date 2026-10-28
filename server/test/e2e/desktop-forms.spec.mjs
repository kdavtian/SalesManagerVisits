import { test, expect, loginViaUi } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 9: on a computer the controls are mouse-sized. Page-wide buttons become normal buttons, a filter <select> is
// the tables' dropdown chip, a cut-off text shows in full on hover, and a date is typed (or taken from the calendar) instead of the wheel.
test("desktop: normal-width buttons, select chips, hover text, typed date", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  await fixtures.createCustomer({ name: `HoverShop${stamp} with a name long enough to be cut off in the customers table column`, created_by: admin.id });
  await loginViaUi(page, admin.email);

  // 1. page-wide buttons: a normal button
  await page.goto("/#/payments");
  const handoffs = page.locator("#payments-handoffs-btn");
  await expect(handoffs).toBeVisible({ timeout: 15000 });
  expect((await handoffs.boundingBox()).width).toBeLessThan(420);

  // 2. Documents: the selects are dropdown chips; picking one filters like the select did
  await page.goto("/#/documents");
  await expect(page.locator("#doc-kind")).toBeHidden();
  const chip = page.locator(".desk-select-chip").first();
  await expect(chip).toBeVisible({ timeout: 15000 });
  await chip.click();
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/") && r.url().includes("kind=payment_slip")),
    page.locator('.desk-pick-menu [data-value="payment_slip"]').click(),
  ]);
  expect(req).toBeTruthy();
  await expect(chip).toHaveClass(/desk-filter-btn-on/);
  expect(await page.locator("#doc-kind").inputValue()).toBe("payment_slip");
  // an open menu never floats over the next page
  await chip.click();
  await expect(page.locator(".desk-pick-menu")).toBeVisible();
  await page.goto("/#/route-plans");
  await expect(page.locator(".desk-col-menu")).toHaveCount(0);

  // 3. a cut-off customer name shows its full text on hover
  await page.goto("/#/customers");
  const name = page.locator("#customer-list .list-row-top > strong", { hasText: `HoverShop${stamp}` }).first();
  await expect(name).toBeVisible({ timeout: 15000 });
  await name.hover();
  await expect(name).toHaveAttribute("title", new RegExp(`HoverShop${stamp} with a name long enough`));

  // 4. the date is typed on a computer (no wheel), Enter confirms
  const picked = page.evaluate(() => import("/js/activityDatePicker.js").then((m) => m.pickDate({ value: "2026-10-28", title: "Due" })));
  const field = page.locator(".desk-date-input");
  await expect(field).toBeFocused();
  await expect(page.locator(".wheel-picker-wrap")).toHaveCount(0);
  await field.fill("2026-11-05");
  await field.press("Enter");
  expect(await picked).toBe("2026-11-05");
});

test("phone keeps the native select and the wheel", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await page.goto("/#/documents");
  await expect(page.locator("#doc-kind")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".desk-select-chip")).toHaveCount(0);
  const picked = page.evaluate(() => import("/js/activityDatePicker.js").then((m) => m.pickDate({ value: "2026-10-28" })));
  await expect(page.locator(".wheel-picker-wrap")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await picked).toBeNull();
});
