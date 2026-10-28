import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// The search bars the screens now build themselves (searchBar.js, docs/architecture-roadmap.md step 7a). They used to be
// added after the fact by three page-wide "enhancer" observers; this guards what those did: the clear "x", the filters inside
// the field, the Orders region filter (it asks /order-meta/list) and the status counts.
test.describe("Search bars", () => {
  test("@smoke Orders: channel and region filters inside the field, region narrows the list, counts on the status tabs", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    const north = await fixtures.createCustomer({ name: `SB North ${Date.now()}`, created_by: admin.id, sales_channel: "retail" });
    const south = await fixtures.createCustomer({ name: `SB South ${Date.now()}`, created_by: admin.id, sales_channel: "retail" });
    await pool.query("UPDATE customers SET region = $2 WHERE id = $1", [north.id, "SB-Region-North"]);
    await pool.query("UPDATE customers SET region = $2 WHERE id = $1", [south.id, "SB-Region-South"]);
    await fixtures.createOrder({ customer_id: north.id, user_id: admin.id, status: "submitted" });
    await fixtures.createOrder({ customer_id: south.id, user_id: admin.id, status: "submitted" });
    await loginViaUi(page, admin.email);
    await page.goto("/#/orders");

    const bar = page.locator(".orders-search-combined");
    await expect(bar).toBeVisible();
    // the channel filter sits inside the field and shows the channel icon (it filters by channel; a person icon used to win a race)
    await expect(bar.locator(".orders-search-actions #order-filter-btn")).toHaveAttribute("aria-label", "Filter by sales channel");
    await expect(bar.locator("#order-filter-btn")).not.toHaveAttribute("data-unified-icon", "true");
    await expect(page.locator("#order-status-filters [data-status] .order-filter-status-icon")).toHaveCount(6);
    await expect(page.locator('#order-status-filters [data-status="submitted"] .order-status-count-badge')).toHaveText(/^\d+$/);

    await expect(page.locator(".orders-list-row, .list-row[data-order-id]").filter({ hasText: north.name })).toBeVisible();
    await expect(page.locator(".list-row[data-order-id]").filter({ hasText: south.name })).toBeVisible();

    // region: the menu lists the customers' regions; picking one asks /order-meta/list and narrows the rows
    await bar.locator(".orders-region-filter-btn").click();
    const menu = page.locator(".orders-region-filter-menu");
    await expect(menu).toBeVisible();
    const regionReq = page.waitForRequest((r) => r.url().includes("/api/order-meta/list") && r.url().includes("region=SB-Region-North"));
    await menu.locator('[data-order-region="SB-Region-North"]').click();
    await regionReq;
    await expect(menu).toBeHidden();
    await expect(bar.locator(".orders-region-filter-btn .activity-search-filter-dot")).toBeVisible();
    await expect(page.locator(".list-row[data-order-id]").filter({ hasText: north.name })).toBeVisible();
    await expect(page.locator(".list-row[data-order-id]").filter({ hasText: south.name })).toHaveCount(0);

    // leaving Orders forgets the region
    await page.goto("/#/customers");
    await page.goto("/#/orders");
    await expect(page.locator(".list-row[data-order-id]").filter({ hasText: south.name })).toBeVisible();
    await expect(page.locator(".orders-region-filter-btn .activity-search-filter-dot")).toHaveCount(0);

    // the clear "x": hidden while empty, shown while typing, empties the field
    const input = page.locator("#order-search");
    const clear = bar.locator(".unified-search-clear");
    await expect(clear).toBeHidden();
    await input.fill("zz");
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(clear).toBeHidden();
  });

  test("Customers, Payments, Products, Activity, Tasks and the plain search boxes carry the same bar", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);

    await page.goto("/#/customers");
    await expect(page.locator(".customers-search-combined .customers-search-actions #sort-btn")).toBeVisible();
    await expect(page.locator(".customers-search-combined .customer-filter-inline")).toHaveCount(1);
    await page.goto("/#/payments");
    await expect(page.locator(".payments-search-combined .payments-filter-wrap #payment-filter-btn")).toBeVisible();
    await page.goto("/#/pricelist");
    await expect(page.locator(".pricelist-search-combined .pricelist-sort-wrap #pricelist-sort-btn")).toBeVisible();

    for (const [hash, input] of [["#/activity", "#activity-search"], ["#/tasks", "#task-search"], ["#/customers", "#customer-search"]]) {
      await page.goto(`/${hash}`);
      const clear = page.locator(`.activity-search-combined:has(${input}) .unified-search-clear`);
      await expect(clear, hash).toBeHidden();
      await page.locator(input).fill("zz");
      await expect(clear, hash).toBeVisible();
      await clear.click();
      await expect(page.locator(input), hash).toHaveValue("");
    }

    // a plain search box (Expenses) gets the "x" inside its own box
    await page.goto("/#/expenses");
    const wrap = page.locator(".search-input-clear-wrap:has(#expenses-search)");
    await expect(wrap).toHaveCount(1);
    await page.locator("#expenses-search").fill("zz");
    await wrap.locator(".unified-search-clear").click();
    await expect(page.locator("#expenses-search")).toHaveValue("");
  });
});
