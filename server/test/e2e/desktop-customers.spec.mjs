import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 1 (owner, 2026-10-27): on a desktop window the Customers list is a table on the shared
// engine (deskTable.js): a column picker, a row count with CSV export, a checkbox column with a bulk bar (assign rep),
// visible filter chips, arrow keys, and (>= 1400 px) the customer card docked beside the list. A phone sees none of it.
test.describe("Desktop Customers table", () => {
  async function seed(fixtures) {
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager", { name: "Desk Rep One" });
    const rep2 = await fixtures.createUser("sales_manager", { name: "Desk Rep Two" });
    const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
    const names = [`Desk${stamp} Alpha`, `Desk${stamp} Beta`, `Desk${stamp} Gamma`];
    const customers = [];
    for (const [i, name] of names.entries()) {
      customers.push(await fixtures.createCustomer({ name, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `DESK${stamp}${i}` }));
    }
    await pool.query("UPDATE customers SET phone = '+374 99 000001', region = 'Yerevan' WHERE id = $1", [customers[0].id]);
    return { admin, rep, rep2, customers, stamp };
  }

  // Enough rows to scroll the page (one INSERT); tracked for the fixture cleanup.
  async function seedMany(fixtures, admin, rep, stamp, n) {
    const { rows } = await pool.query(
      `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng)
       SELECT 'Desk${stamp} Row ' || lpad(g::text, 3, '0'), 'retail', $1, $2, 40.18, 44.51 FROM generate_series(1, $3) g RETURNING id`,
      [admin.id, rep.id, n]
    );
    rows.forEach((r) => fixtures.track("customers", r.id));
    return rows;
  }

  test("columns, row count, CSV export, selection + bulk assign, keyboard, filter chips", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin, rep2, customers, stamp } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/customers");
    await page.locator("#customer-search").fill(`Desk${stamp}`);
    const rows = page.locator("#customer-list > .list-row");
    await expect(rows).toHaveCount(3, { timeout: 15000 });

    // heading row on the engine: the default columns, the select-all box and the gear
    const head = page.locator(".desk-thead-customers");
    await expect(head).toBeVisible();
    await expect(head.locator('[data-sort-key="rep"]')).toBeVisible();
    await expect(head.locator(".desk-select-all")).toBeVisible();
    await expect(rows.first().locator(".desk-cell-rep")).toHaveText("Desk Rep One");
    await expect(page.locator("#customer-desk-foot .desk-foot-count")).toContainText("3");

    // column picker: Phone on, Added off -- remembered on this device
    await head.locator(".desk-col-gear").click();
    const menu = page.locator(".desk-col-menu");
    await expect(menu).toBeVisible();
    await menu.locator('input[data-col="phone"]').check();
    await expect(rows.first().locator(".desk-cell-phone")).toHaveText("+374 99 000001");
    await menu.locator('input[data-col="erp_id"]').check();
    await expect(rows.first().locator(".desk-cell-erp_id")).toContainText("DESK");
    await menu.locator('input[data-col="added"]').uncheck();
    await expect(rows.first().locator(".desk-cell-added")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fieldvisits_desk_cols_customers")))).toContain("phone");

    // sorting by a desktop-only column works from the heading
    await head.locator('[data-sort-key="erp_id"]').click();
    await expect(head.locator('[data-sort-key="erp_id"]')).toHaveClass(/desk-sort-on/);

    // CSV export of the rows on screen: UTF-8 BOM, header, one line per row
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#customer-desk-foot [data-desk-export]").click()]);
    expect(download.suggestedFilename()).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`Desk${stamp} Alpha`);
    expect(csv).toContain("+374 99 000001");
    expect(csv.trim().split("\r\n")).toHaveLength(4);

    // keyboard: arrows move between rows, Space selects
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(rows.nth(1)).toHaveClass(/row-selected/);
    const bulk = page.locator("#customer-bulk");
    await expect(bulk).toBeVisible();
    await expect(bulk.locator(".desk-bulk-count")).toContainText("1");

    // select-all, then bulk assign to the other rep (server PATCH per customer)
    await head.locator(".desk-select-all").click();
    await expect(bulk.locator(".desk-bulk-count")).toContainText("3");
    await bulk.locator('[data-bulk="assign"]').click();
    const sheet = page.locator(".desk-assign-sheet");
    await expect(sheet).toBeVisible();
    await sheet.locator(`input[name="rep"][value="${rep2.id}"]`).check();
    await sheet.locator("[data-apply]").click();
    await expect(sheet).toHaveCount(0);
    await expect(rows.first().locator(".desk-cell-rep")).toHaveText("Desk Rep Two", { timeout: 10000 });
    const { rows: db } = await pool.query("SELECT assigned_manager_id FROM customers WHERE id = ANY($1)", [customers.map((c) => c.id)]);
    expect(db.every((r) => r.assigned_manager_id === rep2.id)).toBe(true);
    await expect(bulk).toBeHidden();

    // visible filter bar: the region filter leaves a chip with an x; Clear empties it
    const filters = page.locator("#customer-desk-filters");
    await expect(filters.locator('[data-desk-filter="assignment"]')).toBeVisible();
    await filters.locator('[data-desk-filter="assignment"]').click();
    const tree = page.locator(".sheet-overlay .sheet").last();
    await expect(tree).toBeVisible();
    await tree.locator("[data-toggle]").first().click();
    await tree.locator("input[data-leaf-id]").first().check();
    await tree.locator("#tree-sheet-done").click();
    await expect(filters.locator(".desk-chip")).toHaveCount(1);
    await expect(filters.locator('[data-desk-filter="assignment"]')).toHaveClass(/desk-filter-btn-on/);
    await filters.locator("[data-desk-clear]").click();
    await expect(filters.locator(".desk-chip")).toHaveCount(0);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-customers.png` });
  });

  test("the heading row stays at the top while a long list scrolls", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin, rep, stamp } = await seed(fixtures);
    await seedMany(fixtures, admin, rep, stamp, 40);
    await loginViaUi(page, admin.email);
    await page.goto("/#/customers");
    await page.locator("#customer-search").fill(`Desk${stamp} Row`);
    const rows = page.locator("#customer-list > .list-row");
    await expect(rows).toHaveCount(40, { timeout: 15000 });
    const head = page.locator(".desk-thead-customers");
    const before = await head.boundingBox();
    await rows.nth(30).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const after = await head.boundingBox();
    expect(after.y).toBeLessThan(before.y);
    // pinned under the top bar, not scrolled away
    const scroller = await page.locator("#app").boundingBox();
    expect(Math.abs(after.y - scroller.y)).toBeLessThan(2);
    await expect(head).toBeInViewport();
  });

  test(">= 1400 px: a row opens the customer card docked beside the list; Esc closes it; a phone has no table parts", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { admin, customers, stamp } = await seed(fixtures);
    await loginViaUi(page, admin.email);
    await page.goto("/#/customers");
    await page.locator("#customer-search").fill(`Desk${stamp} Alpha`);
    const row = page.locator("#customer-list > .list-row").first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    const panel = page.locator(".sheet-overlay.sheet-docked > .customer-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".customer-detail-view")).toContainText(`Desk${stamp} Alpha`, { timeout: 10000 });
    await expect(page).toHaveURL(/#\/customers$/);
    await expect(row).toHaveClass(/row-open/);
    // the list is narrower beside the panel: only the narrow columns stay (Last visit, Debt), no Status cell, no Rep / Added
    await expect(row.locator(".desk-cell-last_visit")).toHaveCount(1);
    await expect(row.locator(".desk-cell-rep")).toHaveCount(0);
    await expect(row.locator(".desk-cell-added")).toHaveCount(0);
    await expect(row.locator("strong")).toBeVisible();
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-customers-panel.png` });
    await row.focus();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(row).not.toHaveClass(/row-open/);
    await expect(row.locator(".desk-cell-added")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/customers");
    await page.locator("#customer-search").fill(`Desk${stamp} Alpha`);
    await expect(page.locator("#customer-list > .list-row").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".desk-thead-customers")).toHaveCount(0);
    await expect(page.locator(".desk-cell")).toHaveCount(0);
    await expect(page.locator("#customer-desk-filters")).toBeHidden();
    await expect(page.locator("#customer-desk-foot")).toBeEmpty();
    expect(customers.length).toBe(3);
  });
});
