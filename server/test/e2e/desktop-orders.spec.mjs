import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 2: Orders on the desktop table engine -- picked columns, the filter bar (rep / channel /
// period / payment / needs attention), the checkbox column feeding the bulk bar (confirm), CSV export; the phone keeps its cards.
test("desktop Orders: columns, filter bar, checkbox bulk confirm, export", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "Desk Orders Rep" });
  const rep2 = await fixtures.createUser("sales_manager", { name: "Desk Orders Other" });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const c1 = await fixtures.createCustomer({ name: `DeskOrd${stamp} Alpha`, created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `DO${stamp}1` });
  const c2 = await fixtures.createCustomer({ name: `DeskOrd${stamp} Beta`, created_by: admin.id, assigned_manager_id: rep2.id, sales_channel: "SM B2B", erp_customer_id: `DO${stamp}2` });
  const o1 = await fixtures.createOrder({ customer_id: c1.id, user_id: rep.id, status: "submitted", total_amd: 45000, order_code: `DO${stamp}-1`, payment_method: "invoice" });
  const o2 = await fixtures.createOrder({ customer_id: c2.id, user_id: rep2.id, status: "submitted", total_amd: 15000, order_code: `DO${stamp}-2`, payment_method: "cash" });
  // the credit-limit gate is not what this spec checks
  await pool.query("UPDATE orders SET credit_status = 'approved' WHERE id = ANY($1)", [[o1.id, o2.id]]);
  await loginViaUi(page, admin.email);
  await page.goto("/#/orders");
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  const rows = page.locator("#orders-list > .list-row");
  await expect(rows).toHaveCount(2, { timeout: 15000 });

  // heading row and default columns: amount, code, rep, created
  const head = page.locator(".desk-thead-orders");
  await expect(head).toBeVisible();
  await expect(head.locator('[data-sort-key="amount"]')).toBeVisible();
  const row1 = page.locator(`#orders-list > .list-row[data-order-id="${o1.id}"]`);
  await expect(row1.locator(".desk-cell-amount")).toContainText("45,000");
  await expect(row1.locator(".desk-cell-code")).toHaveText(`DO${stamp}-1`);
  await expect(row1.locator(".desk-cell-rep")).toHaveText("Desk Orders Rep");
  await expect(page.locator("#orders-desk-foot .desk-foot-count")).toContainText("2");

  // column picker: Payment and ID on
  await head.locator(".desk-col-gear").click();
  await page.locator('.desk-col-menu input[data-col="payment"]').check();
  await page.locator('.desk-col-menu input[data-col="erp_id"]').check();
  await page.keyboard.press("Escape");
  await expect(row1.locator(".desk-cell-payment")).toContainText("Invoice");
  await expect(row1.locator(".desk-cell-erp_id")).toHaveText(`DO${stamp}1`);

  // filter bar: payment = cash leaves one row and a chip; Clear brings both back
  const bar = page.locator("#orders-desk-filters");
  await bar.locator('[data-desk-filter="payment"]').click();
  await page.locator('.desk-pick-menu [data-value="cash"]').click();
  await expect(rows).toHaveCount(1);
  await expect(bar.locator(".desk-chip")).toContainText("Cash");
  await bar.locator("[data-desk-clear]").click();
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  await expect(rows).toHaveCount(2, { timeout: 15000 });

  // rep filter asks the server (user_id)
  await bar.locator('[data-desk-filter="rep"]').click();
  await page.locator(`.desk-pick-menu [data-value="${rep2.id}"]`).click();
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  await expect(rows).toHaveCount(1, { timeout: 15000 });
  await expect(rows.first().locator(".desk-cell-rep")).toHaveText("Desk Orders Other");
  await bar.locator("[data-desk-clear]").click();
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  await expect(rows).toHaveCount(2, { timeout: 15000 });

  // checkbox column feeds the bulk bar: confirm both
  await head.locator(".desk-select-all").click();
  const selectBar = page.locator("#orders-select-bar");
  await expect(selectBar).toBeVisible();
  await expect(selectBar.locator("#orders-select-count")).toContainText("2");
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-orders.png` });
  await expect(selectBar.locator('[data-bulk="confirm"]')).toContainText("(2)");
  await selectBar.locator('[data-bulk="confirm"]').click();
  await expect(selectBar).toBeHidden({ timeout: 15000 });
  await expect.poll(async () => (await pool.query("SELECT status FROM orders WHERE id = ANY($1)", [[o1.id, o2.id]])).rows.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);

  // export of the rows on screen
  await page.locator('#order-status-filters [data-status="confirmed"]').click();
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#orders-desk-foot [data-desk-export]").click()]);
  expect(download.suggestedFilename()).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  expect(csv).toContain(`DO${stamp}-1`);

  // phone: no table parts
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/orders");
  await page.locator('#order-status-filters [data-status="confirmed"]').click();
  await page.locator("#order-search").fill(`DeskOrd${stamp}`);
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await expect(page.locator(".desk-thead-orders")).toHaveCount(0);
  await expect(page.locator("#orders-list .desk-cell")).toHaveCount(0);
});
