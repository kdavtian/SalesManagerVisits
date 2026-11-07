// Purchases, the ultra version (owner, 2026-11-07: "I don't see the already bought products data", "the module needs huge improvements"):
// the Purchase_IN sheet uploaded as a file (the bot is not needed), what the Excel copy holds, the history of each product beside the form
// lines, a second typing of one invoice refused, the next invoice number from the Excel's last one. Isolated: the Excel copy is replaced whole.
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let accCookie, repCookie, opsCookie, p1, p2;
const ERP1 = `PUP-1-${Date.now()}`;
test.before(async () => {
  await startTestServer();
  accCookie = await loginAs((await createUser("accountant")).email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
  opsCookie = await loginAs((await createUser("operations_director")).email);
  p1 = await createProduct({ unit: "4L" });
  p2 = await createProduct({ unit: "1L" });
  await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [p1.id, ERP1]);
  await pool.query("DELETE FROM purchase_invoices");
  await pool.query("DELETE FROM erp_purchase_lines");
});
test.after(async () => {
  await pool.query("DELETE FROM purchase_invoices");
  await pool.query("DELETE FROM suppliers");
  await pool.query("DELETE FROM erp_purchase_lines");
  await cleanupAll();
  await stopTestServer();
});

// A workbook like the Castrol one: totals in row 1, headers in row 2, dates as dates, a formula column, a text invoice number, a blank row
// and a row without a date.
async function castrolWorkbook({ sheetName = "Purchase_IN", withOther = true } = {}) {
  const wb = new ExcelJS.Workbook();
  if (withOther) wb.addWorksheet("Products").addRow(["ProductID", "Brand"]);
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(["", "", "", "", "", "", "", "", "", 1000, 385]);
  ws.addRow(["No", "InvoiceID", "Date", "Supplier", "ProductID", "Brand", "Product_Name", "Size", "QTY", "Cost USD", "SUM", "Cost AMD", "SUM AMD", "Liter", "Info"]);
  ws.addRow([1, 12, new Date(Date.UTC(2026, 8, 17)), "Sole Trans", ERP1, "Castrol", "Edge 5W-30", 4, 100, 15.24, { formula: "I3*J3", result: 1524 }, 5867, { formula: "K3*385", result: 586740 }, 400, "Total: 1524$ Paid: 1524$"]);
  ws.addRow([2, "KAL 1/24", new Date(Date.UTC(2026, 7, 1)), "Luk Oil", "R-X", "Royal", "Gear", 1, 10, 50, 500, 19250, 192500, 10, null]);
  ws.addRow([]);
  ws.addRow([3, 13, null, "Sole Trans", ERP1, "Castrol", "Edge 5W-30", 4, 5, 15, 75, 0, 0, 20, null]);
  ws.addRow([4, 14, new Date(Date.UTC(2026, 6, 3)), "GT Group", ERP1, "Castrol", "Edge 5W-30", 4, 40, { formula: "NA()", result: { error: "#N/A" } }, null, null, null, null, null]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const upload = (buffer, cookie = accCookie, name = "castrol.xlsx") => {
  const form = new FormData();
  form.set("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name);
  return apiFormRequest("/api/purchases/import-excel", { form, cookie });
};

test("the Purchase_IN sheet is read from the uploaded workbook: dates, formula results, text numbers; rows without a date are skipped", async () => {
  assert.equal((await apiRequest("/api/purchases/status", { cookie: accCookie })).data.excel_lines, 0, "empty before the import");
  const r = await upload(await castrolWorkbook());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows, 3);
  assert.equal(r.data.skipped, 1);
  assert.equal(r.data.sheet, "Purchase_IN");
  assert.equal(r.data.invoices, 3);
  assert.equal(r.data.from, "2026-07-03");
  assert.equal(r.data.to, "2026-09-17");
  const { rows } = await pool.query("SELECT invoice_no, to_char(invoice_date,'YYYY-MM-DD') AS d, supplier, qty::float8, cost_usd::float8, amount_amd::float8, info FROM erp_purchase_lines ORDER BY invoice_date");
  assert.deepEqual(rows.map((x) => [x.invoice_no, x.d, x.supplier]), [["14", "2026-07-03", "GT Group"], ["KAL 1/24", "2026-08-01", "Luk Oil"], ["12", "2026-09-17", "Sole Trans"]]);
  assert.equal(rows[2].amount_amd, 586740, "a formula cell gives its result");
  assert.equal(rows[2].info, "Total: 1524$ Paid: 1524$");
  assert.equal(rows[0].cost_usd, null, "an error cell is nothing");
  const status = (await apiRequest("/api/purchases/status", { cookie: accCookie })).data;
  assert.equal(status.excel_lines, 3);
  assert.ok(status.synced_at);
  // the list now shows the Excel invoices
  const list = (await apiRequest("/api/purchases?from=2026-01-01", { cookie: accCookie })).data;
  assert.equal(list.filter((x) => x.status === "excel_only").length, 3);
});

test("the import: a file saved with only the sheet works; a wrong file, a wrong sheet and a missing file are refused; a rep cannot", async () => {
  const alone = await upload(await castrolWorkbook({ sheetName: "Sheet1", withOther: false }));
  assert.equal(alone.status, 200, JSON.stringify(alone.data));
  assert.equal(alone.data.rows, 3);
  const notExcel = await upload(Buffer.from("name,qty\nx,1\n"), accCookie, "x.xlsx");
  assert.equal(notExcel.status, 400);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Other").addRow(["a", "b"]);
  const wrong = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Purchase_IN/);
  assert.equal((await apiFormRequest("/api/purchases/import-excel", { form: new FormData(), cookie: accCookie })).status, 400);
  assert.equal((await upload(await castrolWorkbook(), repCookie)).status, 403);
  assert.equal((await apiRequest("/api/purchases/status", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest(`/api/purchases/product-history?ids=${p1.id}`, { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/purchases/status", { cookie: opsCookie })).status, 200);
  const kept = (await apiRequest("/api/purchases/status", { cookie: accCookie })).data;
  assert.equal(kept.excel_lines, 3, "a refused file leaves the copy as it was");
});

test("a product's history joins the app's and the Excel's purchases; an invoice in both counts once; price change and stock come with it", async () => {
  await upload(await castrolWorkbook());
  const today = new Date().toISOString().slice(0, 10);
  const made = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "12", invoice_date: "2026-09-17", supplier_name: "Sole Trans", usd_rate: 385, lines: [{ product_id: p1.id, qty: 100, cost_usd: 15.24 }] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const second = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "NEW 1", invoice_date: today, supplier_name: "Sole Trans", usd_rate: 386, lines: [{ product_id: p1.id, qty: 20, cost_usd: 16 }] } });
  assert.equal(second.status, 201);
  const h = (await apiRequest(`/api/purchases/product-history?ids=${p1.id},${p2.id}`, { cookie: accCookie })).data;
  const one = h[p1.id];
  assert.deepEqual([one.last.day, one.last.cost_usd, one.last.qty, one.last.supplier, one.last.source], [today, 16, 20, "Sole Trans", "app"]);
  assert.equal(one.prev_cost_usd, 15.24, "the purchase before the last one");
  assert.equal(one.purchases, 2, "Excel's 12 / 17 Sep is the app's invoice 12: counted once; the Excel-only line has no price");
  assert.equal(one.packs_12m, 120);
  assert.equal(one.usd_12m, 1524 + 320);
  assert.ok("stock_qty" in one);
  assert.equal(h[p2.id].last, null);
  assert.equal(h[p2.id].purchases, 0);
  // editing / copying invoice "NEW 1": its own lines are not "bought before"
  const without = (await apiRequest(`/api/purchases/product-history?ids=${p1.id}&exclude_no=${encodeURIComponent("NEW 1")}&exclude_date=${today}`, { cookie: accCookie })).data[p1.id];
  assert.deepEqual([without.last.invoice_no, without.last.cost_usd], ["12", 15.24]);
  assert.equal(without.purchases, 1);
});

test("the same supplier's same invoice number and day is refused with the existing invoice named; Save anyway and editing itself are fine", async () => {
  const body = { invoice_no: " 99/26 ", invoice_date: "2026-05-05", supplier_name: "Orlen Oil", usd_rate: 385, lines: [{ product_id: p1.id, qty: 1, cost_usd: 10 }] };
  const a = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body });
  assert.equal(a.status, 201);
  const dup = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { ...body, invoice_no: "99/26" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "duplicate");
  assert.equal(dup.data.existing_id, a.data.id);
  const other = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { ...body, supplier_name: "Luk Oil" } });
  assert.equal(other.status, 201, "another supplier may use the same number");
  // editing the invoice itself is not "a second typing"
  const edit = await apiRequest(`/api/purchases/${a.data.id}`, { method: "PUT", cookie: accCookie, body: { ...a.data, supplier_name: undefined, supplier_id: a.data.supplier_id, note: "edited" } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const anyway = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { ...body, allow_duplicate: true } });
  assert.equal(anyway.status, 201);
});

test("suppliers: the next number is continued from the newer of the app's and the Excel's last invoice; Excel-only suppliers carry theirs", async () => {
  await upload(await castrolWorkbook());
  const s = (await apiRequest("/api/purchases/suppliers", { cookie: accCookie })).data;
  const sole = s.suppliers.find((x) => x.name === "Sole Trans");
  assert.equal(sole.last_invoice_no, "NEW 1", "the app's invoice of today is newer than the Excel's");
  assert.equal(sole.invoices >= 2, true);
  const luk = s.excel_suppliers.find((x) => x.name === "Luk Oil") ?? s.suppliers.find((x) => x.name === "Luk Oil");
  assert.ok(luk, "Luk Oil is known");
  assert.equal(typeof s.default_usd_rate, "number");
  assert.equal(s.excel_suppliers.find((x) => x.name === "GT Group")?.last_invoice_no, "14");
});
