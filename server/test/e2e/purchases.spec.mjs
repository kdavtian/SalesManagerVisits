import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// The Excel copy is ONE table for everybody (the import and the bot replace it whole): the tests of this file run one after another.
test.describe.configure({ mode: "serial" });
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);

// Owner, 2026-11-07: Purchases beside the Excel Purchase_IN. An invoice only in the Excel is copied into the app in one tap and then matches.
test("@smoke Purchases: an Excel-only invoice is entered in the app from its own lines and then matches the Excel", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const product = await fixtures.createProduct({ unit: "4L" });
  const erpId = `PU-E2E-${Date.now()}`;
  await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [product.id, erpId]);
  const today = new Date().toISOString().slice(0, 10);
  const invoiceNo = `E2E ${Date.now() % 100000}/26`;
  await pool.query(
    "INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, product_name, size_l, qty, cost_usd, amount_amd, excel_row) VALUES ($1, $2, 'E2E Supplier', $3, 'Edge', 4, 120, 15.5, 716100, 1)",
    [invoiceNo, today, erpId]
  );
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, acc.email);
    await page.goto("/#/purchases");
    const row = page.locator(".pu-row", { hasText: "E2E Supplier" });
    await expect(row).toContainText("Only in Excel", { timeout: 15000 });
    await page.screenshot({ path: "test-results/purchases-phone.png" });
    await row.click();
    await page.locator("#pu-copy").click();
    const form = page.locator(".pu-form-sheet");
    await expect(form.locator('[name="invoice_no"]')).toHaveValue(invoiceNo);
    await expect(form.locator(".pu-fl")).toHaveCount(1);
    await form.locator('[name="usd_rate"]').fill("385");
    await page.waitForTimeout(400); // the sheet has finished sliding in
    await page.screenshot({ path: "test-results/purchases-form.png" });
    await form.locator("#pu-save").click();
    await expect(page.locator(".pu-row", { hasText: "E2E Supplier" })).toContainText("Matches Excel", { timeout: 10000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "test-results/purchases-desktop.png" });
  } finally {
    await pool.query("DELETE FROM erp_purchase_lines WHERE erp_product_id = $1", [erpId]);
    await pool.query("DELETE FROM purchase_invoices WHERE invoice_no = $1", [invoiceNo]);
  }
});

test("@smoke Purchases: the Excel file import fills the history; supplier cards filter; KPIs follow", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const today = new Date().toISOString().slice(0, 10);
  const stamp = `${Date.now() % 100000}`;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Purchase_IN");
  ws.addRow(["", "", "", "", "", "", "", "", "", 1000, 385]);
  ws.addRow(["No", "InvoiceID", "Date", "Supplier", "ProductID", "Brand", "Product_Name", "Size", "QTY", "Cost USD", "SUM", "Cost AMD", "SUM AMD", "Liter", "Info"]);
  ws.addRow([1, `I${stamp}`, new Date(`${today}T00:00:00Z`), "E2E Import Alpha", "X1", "Castrol", "Edge", 4, 100, 15, 1500, 0, 577500, 400, "Total: 1500$ Paid: 1500$"]);
  ws.addRow([2, `J${stamp}`, new Date(`${today}T00:00:00Z`), "E2E Import Beta", "X2", "Royal", "Gear", 1, 50, 20, 1000, 0, 385000, 50, null]);
  const file = path.join(os.tmpdir(), `purchase-in-${stamp}.xlsx`);
  await wb.xlsx.writeFile(file);
  await pool.query("DELETE FROM erp_purchase_lines");
  await pool.query("DELETE FROM purchase_invoices"); // the counts below are of this test's two invoices only
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, acc.email);
    await page.goto("/#/purchases");
    // nothing from the Excel yet: the card says why and offers the import
    await expect(page.locator(".pu-excel-empty")).toContainText("have not arrived yet", { timeout: 15000 });
    await shot(page, "purchases-empty-phone");
    await page.locator("#pu-excel-import").click();
    await page.locator("#pu-file").setInputFiles(file);
    await expect(page.locator("#pu-import-go")).toBeEnabled();
    await page.waitForTimeout(450); // the sheet has slid in
    await shot(page, "purchases-import-phone");
    await page.locator("#pu-import-go").click();
    await expect(page.locator(".pu-excel-line")).toContainText("2 lines", { timeout: 15000 });
    await expect(page.locator(".pu-row", { hasText: "E2E Import Alpha" })).toContainText("Only in Excel");
    await expect(page.locator(".pu-kpi").first()).toContainText("2"); // two invoices
    await shot(page, "purchases-list-phone");
    // a supplier card filters; a second tap clears
    await page.locator(".pu-supplier", { hasText: "E2E Import Alpha" }).click();
    await expect(page.locator(".pu-row")).toHaveCount(1);
    await expect(page.locator(".pu-kpi").first()).toContainText("1");
    await page.locator(".pu-supplier", { hasText: "E2E Import Alpha" }).click();
    await expect(page.locator(".pu-row")).toHaveCount(2);
    // the search box
    await page.locator("#pu-list-search").fill(`J${stamp}`);
    await expect(page.locator(".pu-row")).toHaveCount(1);
    await page.locator("#pu-list-search").fill("");
    // the invoice shows the Excel's own note
    await page.locator(".pu-row", { hasText: "E2E Import Alpha" }).click();
    await expect(page.locator(".pu-excel-notes")).toContainText("Paid: 1500$");
    await page.waitForTimeout(450);
    await shot(page, "purchases-invoice-phone");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await shot(page, "purchases-list-desktop");
    // desktop rows carry their own columns: nothing sticks out of its row
    const row = page.locator(".pu-row").first();
    const box = await row.boundingBox();
    const overflow = await row.evaluate((el) => [...el.querySelectorAll("*")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 && c.offsetParent).length);
    expect(box.width).toBeGreaterThan(900);
    expect(overflow, "nothing sticks out of a desktop row").toBe(0);
  } finally {
    await pool.query("DELETE FROM erp_purchase_lines");
    fs.rmSync(file, { force: true });
  }
});

test("@smoke Purchases form: supplier chip, next number, last rate, history beside each line, Enter flow, fixed bar, duplicate warning, draft", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const product = await fixtures.createProduct({ name: "Hist Edge", brand: "Castrol", unit: "4L" });
  await fixtures.createProduct({ name: "Fresh Gear", brand: "Royal", unit: "1L" });
  const erpId = `PU-HIST-${Date.now()}`;
  await pool.query("UPDATE products SET erp_product_id = $2, stock_qty = 120 WHERE id = $1", [product.id, erpId]);
  await pool.query("DELETE FROM erp_purchase_lines");
  await pool.query("INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, product_name, size_l, qty, cost_usd, excel_row) VALUES ('7/26', '2026-09-17', 'E2E Hist Supplier', $1, 'Hist Edge', 4, 100, 15, 1)", [erpId]);
  const supplier = (await pool.query("INSERT INTO suppliers (name, brands) VALUES ('E2E Hist Supplier', 'Castrol') ON CONFLICT (lower(name)) DO UPDATE SET active = true RETURNING id")).rows[0].id;
  const inv = (await pool.query("INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, created_by) VALUES ('8/26', '2026-10-01', $1, 386, $2) RETURNING id", [supplier, acc.id])).rows[0].id;
  await pool.query("INSERT INTO purchase_lines (invoice_id, product_id, product_name, brand, size_l, qty, cost_usd) VALUES ($1, $2, 'Hist Edge', 'Castrol', 4, 50, 16)", [inv, product.id]);
  const newNo = `9/${Date.now() % 100}`;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, acc.email);
    for (const vp of [{ width: 390, height: 844, name: "phone" }, { width: 1440, height: 900, name: "desktop" }]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate(() => localStorage.removeItem("fv_pu_draft"));
      await page.goto("/#/purchases");
      await page.locator("#pu-new").click();
      const form = page.locator(".pu-form-sheet");
      await expect(form.locator("#pu-supplier-chips")).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(500); // the sheet has slid in
      // the bar with Save is on screen before anything is typed
      const bar = await form.locator(".pu-bar").boundingBox();
      expect(bar.y + bar.height, `${vp.name}: the bottom bar is inside the window`).toBeLessThanOrEqual(vp.height + 1);
      await form.locator('[data-supplier="E2E Hist Supplier"]').click();
      // last rate offered, the next number one tap away
      await expect(form.locator("#pu-rate")).toHaveValue("386");
      await expect(form.locator("#pu-next")).toContainText("9/26");
      await expect(form.locator("#pu-no-hints")).toContainText("8/26");
      await form.locator("#pu-no").fill(newNo);
      // products: type, Enter adds, packs, Enter, price, Enter -> back to the search
      await form.locator("#pu-search").fill("Hist");
      await form.locator("#pu-search").press("Enter");
      await expect(form.locator(".pu-fl")).toHaveCount(1);
      await expect(form.locator(".pu-fl-hist")).toContainText("Last bought: $16.00", { timeout: 10000 });
      await expect(form.locator(".pu-fl-hist")).toContainText("In stock: 120");
      await expect(form.locator(".pu-fl-hist")).toContainText("12 months: 150 packs");
      await page.keyboard.type("60");
      await page.keyboard.press("Enter");
      await page.keyboard.type("17");
      await expect(form.locator(".pu-delta-up")).toContainText("+6%"); // 16 -> 17
      await page.keyboard.press("Enter");
      await expect(form.locator("#pu-search")).toBeFocused();
      await form.locator("#pu-search").fill("Fresh");
      await form.locator("#pu-search").press("Enter");
      await expect(form.locator(".pu-fl-hist").nth(1)).toContainText("Not bought before", { timeout: 10000 });
      await page.keyboard.type("10");
      await page.keyboard.press("Enter");
      await page.keyboard.type("9.5");
      await page.keyboard.press("Enter");
      // totals: 60 x 17 + 10 x 9.5 = 1115.00 USD; 70 packs; 60 x 4 + 10 x 1 = 250 L
      await expect(form.locator("#pu-total")).toContainText("$1,115.00");
      await expect(form.locator("#pu-total")).toContainText("70 packs");
      await expect(form.locator("#pu-total")).toContainText("250 L");
      await shot(page, `purchases-form-${vp.name}`);
      // the draft survives a closed sheet
      await page.waitForTimeout(600);
      await form.locator("#pu-cancel").click();
      await page.locator("#pu-new").click();
      await expect(page.locator(".pu-draft")).toBeVisible();
      await expect(page.locator("#pu-no")).toHaveValue(newNo);
      await expect(page.locator(".pu-fl")).toHaveCount(2);
      await shot(page, `purchases-form-draft-${vp.name}`);
      // saving works (the bar stayed in reach), the list shows it and the draft is gone
      await page.locator("#pu-save").click();
      await expect(page.locator(".pu-form-sheet")).toHaveCount(0, { timeout: 15000 }); // saved: the form is gone
      await expect(page.locator(".pu-row", { hasText: newNo })).toBeVisible({ timeout: 15000 });
      expect(await page.evaluate(() => localStorage.getItem("fv_pu_draft"))).toBeNull();
      // the same supplier, number and day again: warned at once; Save anyway is the way through
      await page.locator("#pu-new").click();
      await page.locator('[data-supplier="E2E Hist Supplier"]').click();
      await page.locator("#pu-no").fill(newNo);
      await expect(page.locator("#pu-dup")).toBeVisible();
      await expect(page.locator("#pu-dup-open")).toBeVisible();
      await shot(page, `purchases-form-duplicate-${vp.name}`);
      await page.locator("#pu-cancel").click();
      await pool.query("DELETE FROM purchase_invoices WHERE invoice_no = $1", [newNo]);
      await page.evaluate(() => localStorage.removeItem("fv_pu_draft"));
    }
    // an empty form says what is missing next to each field, not in one line at the bottom
    await page.goto("/#/purchases");
    await page.locator("#pu-new").click();
    await page.locator("#pu-save").click();
    await expect(page.locator("#err-supplier")).toBeVisible();
    await expect(page.locator("#err-no")).toBeVisible();
    await expect(page.locator("#err-lines")).toBeVisible();
    await shot(page, "purchases-form-errors");
  } finally {
    await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = $1 OR invoice_no = $2", [supplier, newNo]);
    await pool.query("DELETE FROM erp_purchase_lines");
    await page.evaluate(() => localStorage.removeItem("fv_pu_draft")).catch(() => {});
    await page.close(); // nothing of the page may still be saving while the rows go
    await pool.query("DELETE FROM purchase_invoices WHERE supplier_id = $1", [supplier]);
    await pool.query("DELETE FROM suppliers WHERE id = $1", [supplier]);
  }
});

test.describe("narrow Armenian", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test("@smoke Armenian at 320 px: the list, the form with a long product name and the import sheet fit the screen", async ({ page, fixtures }) => {
    const acc = await fixtures.createUser("accountant");
    const product = await fixtures.createProduct({ name: "Castrol Edge Professional EC 0W-20 Շատ երկար անունով յուղ", brand: "Castrol", unit: "4L" });
    const erpId = `PU-HY-${Date.now()}`;
    await pool.query("UPDATE products SET erp_product_id = $2, stock_qty = 5000 WHERE id = $1", [product.id, erpId]);
    const today = new Date().toISOString().slice(0, 10);
    await pool.query("DELETE FROM erp_purchase_lines");
    await pool.query("INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, product_name, size_l, qty, cost_usd, excel_row) VALUES ('KAL 12/26', $2, 'E2E Երկար Մատակարար ՍՊԸ', $1, 'x', 4, 1200, 15.5, 1)", [erpId, today]);
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    try {
      await loginViaUi(page, acc.email);
      await page.goto("/#/purchases");
      await expect(page.locator(".pu-row").first()).toBeVisible({ timeout: 15000 });
      expect(await fits(), "list").toBe(true);
      await shot(page, "purchases-hy-list");
      await page.locator("#pu-import").click();
      await page.waitForTimeout(450);
      expect(await fits(), "import sheet").toBe(true);
      await shot(page, "purchases-hy-import");
      await page.keyboard.press("Escape");
      await page.locator("#pu-new").click();
      await expect(page.locator("#pu-supplier-chips")).toBeVisible();
      await page.locator('[data-supplier^="E2E Երկար"]').click();
      await page.locator("#pu-search").fill("Castrol Edge");
      await page.locator("#pu-search").press("Enter");
      await expect(page.locator(".pu-fl-hist")).toContainText("Վերջին գնում", { timeout: 10000 });
      await page.waitForTimeout(450);
      expect(await fits(), "form").toBe(true);
      const sheetOverflow = await page.locator(".pu-form-body").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(sheetOverflow, "the form body does not scroll sideways").toBe(false);
      await shot(page, "purchases-hy-form");
      // every tap target of the form is at least 44 px high
      const small = await page.locator(".pu-form button, .pu-form input").evaluateAll((els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43 && !e.classList.contains("pu-hint-chip")).map((e) => e.id || e.className));
      expect(small, "44 px targets").toEqual([]);
    } finally {
      await pool.query("DELETE FROM erp_purchase_lines");
      await pool.query("DELETE FROM suppliers WHERE name LIKE 'E2E%'");
    }
  });
});
