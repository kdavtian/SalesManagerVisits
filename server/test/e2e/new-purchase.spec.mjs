import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-27: "when user tap New > app asks to choose supplier > brings all possible products from that supplier. Also have AI icon
// button which asks to fill the quantity fields smartly which can be changed as well. Also can be saved as draft".
test("@smoke new purchase: choose the supplier, all its products at 0, AI fills, change, create", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const tag = `NPU${Date.now().toString(36)}`;
  const supplier = `${tag} Supplier`;
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [supplier]);
  // one product that needs ordering (sells 2 a day, 40 in stock) and one that does not (no sales, 500 in stock)
  const needs = await fixtures.createProduct({ name: `${tag} Edge 1L` });
  const calm = await fixtures.createProduct({ name: `${tag} Calm 4L` });
  const erpA = `${tag}-A`;
  await pool.query("UPDATE products SET erp_product_id = $2, unit = '1L', items_per_pack = 12, stock_qty = 40, brand = 'Castrol', created_at = now() - interval '2 years' WHERE id = $1", [needs.id, erpA]);
  await pool.query("UPDATE products SET erp_product_id = $2, unit = '4L', items_per_pack = 4, stock_qty = 500, brand = 'Castrol' WHERE id = $1", [calm.id, `${tag}-B`]);
  for (let w = 0; w < 26; w += 1) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, $2, CURRENT_DATE - $3::int, $4, 14, 1)", [tag, `${tag}-${w}`, w * 7 + 1, erpA]);
  }
  for (const p of [needs, calm]) {
    const { rows: [inv] } = await pool.query("INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, arrived_at) VALUES ($1, CURRENT_DATE - 100, $2, 400, 'arrived', now() - interval '100 days') RETURNING id", [`${tag}-INV-${p.id}`, s.id]);
    await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 60, 3.5)", [inv.id, p.id]);
  }
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/purchases");
    await page.locator("#pu-new").click();
    const pick = page.locator(`[data-pick="${supplier}"]`);
    await expect(pick).toContainText("2 products");
    await pick.click();
    await expect(page).toHaveURL(/#\/purchases\/suggestions\?supplier=.*&all=1/);
    await expect(page.locator(".detail-header-title h1")).toHaveText("New purchase");
    // every product of the supplier, also the one needing nothing, all at 0
    const lineA = page.locator(`.ps-line[data-line="${needs.id}"]`);
    const lineB = page.locator(`.ps-line[data-line="${calm.id}"]`);
    await expect(lineA.locator(".ps-qty strong")).toHaveText("0 boxes");
    await expect(lineB.locator(".ps-qty strong")).toHaveText("0 boxes");
    // AI fills the smart quantities; the calm product stays 0
    const card = page.locator(".ps-supplier", { hasText: supplier });
    await card.locator("[data-ai-fill]").click();
    await expect(card.locator(".ps-card-msg")).toContainText("Filled smartly: 1 products");
    const filled = await lineA.locator(".ps-qty strong").textContent();
    const boxes = Number(filled.match(/^(\d+) boxes/)[1]);
    expect(boxes).toBeGreaterThan(0);
    await expect(lineB.locator(".ps-qty strong")).toHaveText("0 boxes");
    // the owner changes a quantity: + on the calm product
    await lineB.locator("[data-plus]").click();
    await expect(lineB.locator(".ps-qty strong")).toHaveText("5 boxes");
    // save as draft works here too
    await card.locator("[data-share-menu]").click();
    await card.locator("[data-save-draft]").click();
    await expect(card.locator(".ps-card-msg")).toContainText("Saved as draft");
    // Create: the purchase form with both products
    await card.locator(".ps-create").click();
    const form = page.locator(".pu-form-sheet");
    await expect(form).toBeVisible();
    await expect(form).toContainText(needs.name);
    await expect(form).toContainText(calm.name);
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [tag]);
    await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = $1", [s.id]);
    await pool.query("DELETE FROM purchase_suggestion_drafts WHERE supplier ILIKE $1", [`${tag}%`]);
    await pool.query("DELETE FROM suppliers WHERE id = $1", [s.id]);
  }
});
