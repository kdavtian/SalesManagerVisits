import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-25 (screenshots of the New purchase form): the status in one row; an Ordered purchase folds the invoice fields away and gets
// its expected date from the lead time; "Add from smart suggestions" brings this supplier's suggestions in; while Ordered each line says the
// order step and rounds a quantity up to it; Save says what is missing.
test("purchase form: Ordered folds the invoice, expected = today + lead time, suggestions added, steps rounded", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const tag = `PFS${Date.now().toString(36)}`;
  const oil = await fixtures.createProduct({ name: `${tag} Edge 5W-30 1L` });
  const erpId = `${tag}-ERP`;
  await pool.query("UPDATE products SET erp_product_id = $2, unit = '1L', items_per_pack = 12, stock_qty = 10, brand = 'Castrol', created_at = now() - interval '2 years' WHERE id = $1", [oil.id, erpId]);
  for (let w = 0; w < 26; w += 1) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, $2, CURRENT_DATE - $3::int, $4, 14, 1)", [tag, `${tag}-${w}`, w * 7 + 1, erpId]);
  }
  const supplier = `${tag} Supplier`;
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [supplier]);
  const { rows: [inv] } = await pool.query("INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, arrived_at) VALUES ($1, CURRENT_DATE - 100, $2, 400, 'arrived', now() - interval '100 days') RETURNING id", [`${tag}-INV`, s.id]);
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 60, 3.5)", [inv.id, oil.id]);
  await pool.query("UPDATE app_settings SET demand_lead_time_days = 45 WHERE id = 1");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/purchases");
    await page.locator("#pu-new").click();
    const form = page.locator(".pu-form-sheet");
    await expect(form.locator("#pu-save-why")).toHaveText("Choose the supplier to save.");
    await form.locator('[data-status="ordered"]').click();
    await expect(form.locator("#pu-invoice")).not.toHaveAttribute("open", "");
    const expected = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-GB", { timeZone: "Asia/Yerevan" }).split("/").join("-");
    await expect(form.locator("#pu-expected")).toHaveText(expected);
    await expect(form.locator("#pu-expected-hint")).toContainText("45 days");
    await form.locator(`[data-supplier="${supplier}"]`).click();
    await expect(form.locator("#pu-save-why")).toHaveText("Add at least one product to save.");
    await form.locator("#pu-from-suggest").click();
    await expect(form.locator("#pu-from-suggest-msg")).toContainText("1 products added");
    const qty = form.locator('input[data-f="qty"]').first();
    expect(Number(await qty.inputValue()) % 60).toBe(0);
    await expect(form.locator("#pu-save-why")).toBeHidden();
    // a quantity that is not a whole step: the line says so and rounds it up
    await qty.fill("70");
    await expect(form.locator(".pu-fl-step")).toContainText("5 boxes = 60");
    await form.locator("[data-round]").click();
    await expect(qty).toHaveValue("120");
    await expect(form.locator("[data-round]")).toHaveCount(0);
    // a bad rate typed while Ordered: Save opens the folded invoice section so the error is seen (review 2026-11-26)
    await form.locator("#pu-invoice > summary").click();
    await form.locator("#pu-rate").fill("abc");
    await form.locator("#pu-invoice > summary").click();
    await expect(form.locator("#pu-invoice")).not.toHaveAttribute("open", "");
    await form.locator("#pu-save").click();
    await expect(form.locator("#pu-invoice")).toHaveAttribute("open", "");
    await expect(form.locator("#err-rate")).toBeVisible();
    await form.locator("#pu-rate").fill("400");
    // received: the invoice fields open, the step hint goes
    await form.locator('[data-status="arrived"]').click();
    await expect(form.locator("#pu-invoice")).toHaveAttribute("open", "");
    await expect(form.locator(".pu-fl-step")).toHaveText("");
  } finally {
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [tag]);
    await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = $1", [s.id]);
    await pool.query("DELETE FROM suppliers WHERE id = $1", [s.id]);
  }
});
