import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: customers type/tier filter (tier rows, live counts), instant order menu, debt balances card v3,
// calendar icon for the special date range.
test.describe("UI batch 1.353", () => {
  test("type & tier sheet: tiers on two rows, counts follow the other group and the search", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const tag = `TT${Date.now()}`;
    const spec = [
      ["gold", "Ավտոսերվիս", 3],
      ["gold", "Յուղման կետ", 2],
      ["silver", "Ավտոսերվիս", 4],
      ["potential", "Խանութ", 1],
    ];
    let n = 0;
    for (const [tier, category, count] of spec) {
      for (let i = 0; i < count; i++) {
        await pool.query(
          `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng, erp_customer_id, region, customer_tier, category)
           VALUES ($1, 'SM YVN', $2, $2, 40.1, 44.5, $3, 'Yerevan', $4, $5)`,
          [`${tag} C${n}`, admin.id, `${tag}-${n}`, tier, category]
        );
        n++;
      }
    }
    try {
      await loginViaUi(page, admin.email);
      await page.goto("/#/customers");
      await page.locator("#customer-search").fill(tag);
      await expect.poll(async () => page.locator("#customer-list .list-row").count(), { timeout: 10000 }).toBe(10);
      await page.locator('[data-filter-btn="channel"]').click();
      const sheet = page.locator(".type-tier-sheet");
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(600); // the sheet slides in

      // gold / silver / bronze share one row, potential / competitor the next
      const y = async (tier) => (await sheet.locator(`[data-tier="${tier}"]`).boundingBox()).y;
      expect(Math.abs((await y("gold")) - (await y("silver")))).toBeLessThan(3);
      expect(Math.abs((await y("silver")) - (await y("bronze")))).toBeLessThan(3);
      expect(Math.abs((await y("potential")) - (await y("competitor")))).toBeLessThan(3);
      expect(await y("potential")).toBeGreaterThan((await y("gold")) + 30);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const count = (sel) => sheet.locator(sel).locator("[data-count]");
      await expect(count('[data-tier="gold"]')).toHaveText("5");
      await expect(count('[data-tier="silver"]')).toHaveText("4");
      await expect(count('[data-type="Ավտոսերվիս"]')).toHaveText("7");
      await expect(sheet.locator("#ttf-done")).toContainText("(10)");

      // gold on: workshop 3, oil point 2, the rest 0 (dimmed); silver's count follows the (empty) type group
      await sheet.locator('[data-tier="gold"]').click();
      await expect(count('[data-type="Ավտոսերվիս"]')).toHaveText("3");
      await expect(count('[data-type="Յուղման կետ"]')).toHaveText("2");
      await expect(count('[data-type="Խանութ"]')).toHaveText("0");
      await expect(sheet.locator('[data-type="Խանութ"]')).toHaveClass(/ttf-empty/);
      await expect(sheet.locator("#ttf-done")).toContainText("(5)");

      // workshop on as well: tier counts now follow the workshop type
      await sheet.locator('[data-type="Ավտոսերվիս"]').click();
      await expect(count('[data-tier="gold"]')).toHaveText("3");
      await expect(count('[data-tier="silver"]')).toHaveText("4");
      await expect(sheet.locator("#ttf-done")).toContainText("(3)");
      await sheet.locator("#ttf-done").click();
      await expect(page.locator("#customer-list .list-row")).toHaveCount(3);
    } finally {
      await pool.query("DELETE FROM customers WHERE erp_customer_id LIKE $1", [`${tag}-%`]);
    }
  });

  test("order menu opens at once with four buttons and loads nothing until one is chosen", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const customer = await fixtures.createCustomer({ created_by: admin.id, name: "Menu Customer" });
    const hits = [];
    page.on("request", (req) => {
      const url = req.url();
      if (/reorder-profile|recent-orders/.test(url)) hits.push(url);
    });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    const btn = page.locator("#new-order-btn");
    await expect(btn).toBeVisible();
    await page.waitForLoadState("networkidle");
    hits.length = 0; // whatever the customer page itself loaded does not count -- only what the menu asks for
    await btn.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.waitForTimeout(900);
    await btn.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
    const menu = page.locator(".om-sheet");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".om-option")).toHaveCount(4);
    expect(hits).toEqual([]);

    // "Repeat order" is the only one that asks for data, and only after it is tapped
    await menu.locator('[data-om="pick"]').click();
    await expect(menu.locator(".om-loading, .om-option, .muted").first()).toBeVisible();
    await expect.poll(() => hits.filter((u) => /recent-orders/.test(u)).length).toBe(1);

    // "Repeat last order" goes straight to the order screen, which does its own loading
    await page.locator(".om-sheet [data-om='back']").click();
    await page.locator(".om-sheet [data-om='last']").click();
    await expect(page).toHaveURL(/#\/orders\/new\/\d+\?from=last/);
  });

  test("debt card: ID • name without the repeated ID, due chip + overdue amount under the total, green chip when nothing is due", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const row = (over) => ({
      internal_customer_id: 1, customer_id: "10123", customer_name: "10123 Shirak Garage", remaining_balance: 1200000, overdue_amd: 300000,
      oldest_due_days: 14, unrecorded_amd: 0, last_payment_date: "2026-10-01", last_visit_at: "2026-10-10T08:00:00Z",
      sales_channel: "SM YVN", assigned_manager_id: admin.id, assigned_manager_name: "Rep", ...over,
    });
    await page.route("**/api/debt-balances*", (route) =>
      route.fulfill({
        json: {
          rows: [
            row({}),
            row({ internal_customer_id: 2, customer_id: "10124", customer_name: "10124 - Green Customer With A Fairly Long Name LLC", remaining_balance: 500000, overdue_amd: 0, oldest_due_days: -7 }),
          ],
          as_of_date: null,
          sync: { last_synced_at: new Date().toISOString() },
        },
      })
    );
    await loginViaUi(page, admin.email);
    await page.goto("/#/debt-balances");
    const cards = page.locator(".debt-balance-card");
    await expect(cards).toHaveCount(2, { timeout: 10000 });
    const first = cards.nth(0);
    await expect(first.locator(".debt-name")).toHaveText("Shirak Garage");
    await expect(first.locator(".debt-id")).toContainText("10123");
    await expect(first.locator(".debt-due-line .due-chip-overdue")).toHaveText(/14/);
    await expect(first.locator(".debt-due-amount")).toContainText("300,000");
    const total = await first.locator(".debt-balance-amount").boundingBox();
    const due = await first.locator(".debt-due-line").boundingBox();
    expect(due.y).toBeGreaterThan(total.y + total.height - 2); // under the total
    expect(Math.abs(due.x + due.width - (total.x + total.width))).toBeLessThan(4); // right aligned with it
    // last visit above last payment, both on the left
    const visit = await first.locator(".debt-date-line").nth(0).boundingBox();
    const pay = await first.locator(".debt-date-line").nth(1).boundingBox();
    expect(pay.y).toBeGreaterThan(visit.y);
    expect(Math.abs(pay.x - visit.x)).toBeLessThan(2);

    const second = cards.nth(1);
    await expect(second.locator(".debt-name")).toHaveText("Green Customer With A Fairly Long Name LLC");
    await expect(second.locator(".due-chip-ok")).toContainText("7");
    await expect(second.locator(".debt-due-amount")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("activity: the special date range is a calendar icon tab", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/activity");
    const tab = page.locator('.activity-tab[data-range="custom"]');
    await expect(tab).toBeVisible();
    await expect(tab.locator("svg")).toHaveCount(1);
    await expect(tab).not.toHaveText(/\S/);
    const box = await tab.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await tab.click();
    await expect(page.locator(".activity-custom-range")).toBeVisible();
  });

  test("new customer sheet: region and subregion fields have the same height", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/map");
    const h = await page.evaluate(() => {
      const host = document.createElement("form");
      host.innerHTML = `<div class="form-row-2"><label>R<select id="a"><option>x</option></select></label><label>S<input id="b" /></label></div>`;
      document.body.appendChild(host);
      return [document.querySelector("#a").getBoundingClientRect().height, document.querySelector("#b").getBoundingClientRect().height];
    });
    expect(Math.abs(h[0] - h[1])).toBeLessThan(1);
  });
});
