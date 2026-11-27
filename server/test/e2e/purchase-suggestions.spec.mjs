import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-25: smart purchase suggestions per supplier -- stock now, the order in whole steps (+ / − by 5 boxes), stock and days left
// after receiving; "Create purchase" opens the purchase form filled (Ordered, the supplier, the products and quantities).
test("@iphone purchase suggestions: a step up recomputes the line, Create purchase fills the form", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const tag = `PSE${Date.now().toString(36)}`;
  const oil = await fixtures.createProduct({ name: `${tag} Edge 5W-30 1L` });
  const erpId = `${tag}-ERP`;
  await pool.query("UPDATE products SET erp_product_id = $2, unit = '1L', items_per_pack = 12, stock_qty = 40, brand = 'Castrol', created_at = now() - interval '2 years' WHERE id = $1", [oil.id, erpId]);
  for (let w = 0; w < 26; w += 1) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, $2, CURRENT_DATE - $3::int, $4, 14, 1)", [tag, `${tag}-${w}`, w * 7 + 1, erpId]);
  }
  const supplier = `${tag} Supplier`;
  const { rows: [s] } = await pool.query("INSERT INTO suppliers (name) VALUES ($1) RETURNING id", [supplier]);
  const { rows: [inv] } = await pool.query("INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, status, arrived_at) VALUES ($1, CURRENT_DATE - 100, $2, 400, 'arrived', now() - interval '100 days') RETURNING id", [`${tag}-INV`, s.id]);
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, qty, cost_usd) VALUES ($1, $2, 'x', 60, 3.5)", [inv.id, oil.id]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/purchases");
    await page.locator("#pu-suggest").click();
    await expect(page).toHaveURL(/#\/purchases\/suggestions/);
    const line = page.locator(`.ps-line[data-line="${oil.id}"]`);
    await expect(line).toBeVisible();
    await expect(line).toContainText("In stock 40 pcs");
    await expect(line).toContainText("Runs out before arrival");
    const qty = line.locator(".ps-qty strong");
    const before = await qty.textContent();
    const boxes = Number(before.match(/^(\d+) boxes/)[1]);
    expect(boxes % 5).toBe(0);
    await line.locator("[data-plus]").click();
    await expect(qty).toHaveText(`${boxes + 5} boxes`);
    // compact row (owner 2026-11-26): the details open on a tap on the row: the numbers, back to the suggestion, the supplier
    await expect(line.locator(".ps-details")).toBeHidden();
    await line.locator("[data-toggle]").click();
    await expect(line.locator(".ps-details")).toBeVisible();
    await expect(line.locator("[data-reset]")).toBeVisible();
    // step 3 (owner 2026-11-26): why the order, and the sales lost before the goods come (40 in stock, 2 a day, 45 days: 25 empty days)
    await expect(line.locator(".ps-why")).toContainText("Why:");
    await expect(line.locator(".ps-lost")).toContainText("50 pcs");
    // urgent only: this product runs out before the goods come, so it stays
    const urgent = page.locator("#ps-urgent");
    await expect(urgent).toBeVisible();
    await urgent.click();
    await expect(urgent).toHaveAttribute("aria-pressed", "true");
    await expect(line).toBeVisible();
    await urgent.click();
    await expect(urgent).toHaveAttribute("aria-pressed", "false");
    await expect(line.locator(".ps-details")).toBeVisible(); // still open after the list was drawn again
    // owner 2026-11-26: more than twice the cover days after receiving is flagged "Too much" (2 a day: 2 more steps = well over 90 days)
    await expect(line.locator(".badge-warning")).toHaveCount(0);
    await line.locator("[data-plus]").click();
    await line.locator("[data-plus]").click();
    await expect(line.locator(".badge-warning")).toContainText(/Too much: \d+ days/);
    await line.locator("[data-minus]").click();
    await line.locator("[data-minus]").click();
    await expect(qty).toHaveText(`${boxes + 5} boxes`);
    // the details stay open through − / +
    await expect(line.locator(".ps-details")).toBeVisible();
    // "what if": another cover for this screen only, the chip says so; back to the settings
    await page.locator("#ps-plan-chip").click();
    await page.locator('#ps-plan-edit input[name="cover"]').fill("90");
    await page.locator('#ps-plan-edit button[type="submit"]').click();
    await expect(page.locator("#ps-plan-chip")).toContainText("90");
    await expect(page.locator(".ps-plan-note")).toBeVisible();
    await page.locator("#ps-plan-chip").click();
    await page.locator("#ps-plan-reset").click();
    await expect(page.locator("#ps-plan-chip")).toContainText("45");
    await expect(page.locator(".ps-plan-note")).toHaveCount(0);
    await expect(line).toBeVisible();
    // budget (owner 2026-11-26, step 4): 1$ fits nothing -> the product waits for the next order; "No budget" gives the suggestion back
    await page.locator("#ps-budget-chip").click();
    await page.locator('#ps-budget-edit input[name="budget"]').fill("1");
    await page.locator('#ps-budget-edit button[type="submit"]').click();
    await expect(line.locator(".ps-qty strong")).toHaveText("0 boxes");
    await expect(line).toContainText("Next order");
    await expect(page.locator("#ps-budget-chip")).toContainText("Budget 1$");
    await page.locator("#ps-budget-chip").click();
    await page.locator("#ps-budget-clear").click();
    await expect(line.locator(".ps-qty strong")).toHaveText(`${boxes} boxes`);
    await expect(line).not.toContainText("Next order");
    await line.locator("[data-plus]").click();
    // sort (owner 2026-11-26): products by default, urgency, price -- remembered
    await expect(page.locator('#ps-sort [data-sort="products"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('#ps-sort [data-sort="price"]').click();
    await expect(page.locator('#ps-sort [data-sort="price"]')).toHaveAttribute("aria-pressed", "true");
    await expect(line).toBeVisible();
    // share as Excel: SKU, product, packs of the supplier's order
    const pick = page.locator("#ps-share-pick");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.locator("#ps-share").click();
        if (await pick.isVisible()) await pick.locator(`[data-share="${supplier}"]`).click();
      })(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^purchase-.*\.xlsx$/);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await download.path());
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).values.slice(1)).toEqual(["SKU", "Product", "Packs"]);
    const rowOf = ws.getRows(2, ws.rowCount - 1).find((r) => String(r.getCell(2).value).includes(oil.name));
    expect(rowOf.getCell(1).value).toBe(erpId);
    expect(rowOf.getCell(3).value).toBe(boxes + 5);
    // a finger on the card while scrolling does not grey it (owner screenshot 2026-11-27: the shared .card pressed look)
    const cardEl = page.locator(".ps-supplier", { hasText: supplier });
    const bgBefore = await cardEl.evaluate((el) => getComputedStyle(el).backgroundColor);
    const box = await line.locator(".ps-price").boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(400); // past the pressed-look transition
    expect(await cardEl.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(bgBefore);
    await page.mouse.up();
    // the supplier's card makes the purchase
    const card = page.locator(".ps-supplier", { hasText: supplier });
    await card.locator(".ps-create").click();
    const form = page.locator(".pu-form-sheet");
    await expect(form).toBeVisible();
    await expect(form).toContainText(supplier);
    await expect(form).toContainText(oil.name);
    // the pieces chosen on the screen and the last price per piece are in the form's line
    await expect(form.locator('input[data-f="qty"]').first()).toHaveValue(String((boxes + 5) * 12));
    await expect(form.locator('input[data-f="cost_usd"]').first()).toHaveValue("3.5");
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [tag]);
    await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = $1", [s.id]);
    await pool.query("DELETE FROM suppliers WHERE id = $1", [s.id]);
  }
});
