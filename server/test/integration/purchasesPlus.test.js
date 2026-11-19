// Purchases, the ultra version (owner, 2026-11-07: "I don't see the already bought products data", "the module needs huge improvements"):
// the Purchase_IN sheet uploaded as a file (the bot is not needed), what the Excel copy holds, the history of each product beside the form
// lines, a second typing of one invoice refused, the next invoice number from the Excel's last one. Isolated: the Excel copy is replaced whole.
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, apiFormRequest, loginAs, testBaseUrl } from "./helpers.js";
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

test("an import with an impossible date skips that row (no 500); a sheet found only by its columns must look like purchases", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Purchase_IN");
  ws.addRow([]);
  ws.addRow(["No", "InvoiceID", "Date", "Supplier", "ProductID", "Brand", "Product_Name", "Size", "QTY", "Cost USD"]);
  ws.addRow([1, "OK1", "17.09.2026", "Sole Trans", "P", "Castrol", "Edge", 4, 10, 15]);
  ws.addRow([2, "BAD1", "31.02.2026", "Sole Trans", "P", "Castrol", "Edge", 4, 10, 15]);
  ws.addRow([3, "BAD2", "2026-13-01", "Sole Trans", "P", "Castrol", "Edge", 4, 10, 15]);
  ws.addRow([4, "BAD3", "09/17/2026", "Sole Trans", "P", "Castrol", "Edge", 4, 10, 15]);
  const r = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows, 1);
  assert.equal(r.data.skipped, 3);
  // a sales sheet with similar headers but no supplier / product is not taken for purchases
  const sales = new ExcelJS.Workbook();
  sales.addWorksheet("Orders").addRow(["InvoiceID", "Date", "QTY", "Cost USD", "Customer"]);
  sales.getWorksheet("Orders").addRow(["A1", new Date(Date.UTC(2026, 8, 1)), 2, 5, "x"]);
  const refused = await upload(Buffer.from(await sales.xlsx.writeBuffer()));
  assert.equal(refused.status, 400);
  assert.equal((await apiRequest("/api/purchases/status", { cookie: accCookie })).data.excel_lines, 1, "the copy is untouched");
});

test("two people saving the same invoice at the same moment: one is saved, the other is told it exists", async () => {
  const body = (ref) => ({ invoice_no: "RACE-1", invoice_date: "2026-04-04", supplier_name: "Race Supplier", usd_rate: 385, client_ref: ref, lines: [{ product_id: p1.id, qty: 1, cost_usd: 10 }] });
  const [a, b] = await Promise.all([
    apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: body("race-a") }),
    apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: body("race-b") }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM purchase_invoices WHERE invoice_no = 'RACE-1'");
  assert.equal(rows[0].n, 1);
});

test("a product id beyond the database range is ignored, not a 500", async () => {
  const r = await apiRequest("/api/purchases/product-history?ids=99999999999,-5,abc", { cookie: accCookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {});
});

// Owner plan P3 (2026-11-20): the paper of an invoice, its history, and the Excel export
test("an invoice's photo / PDF, its history (who changed what), the export of the period; a rep is refused; the history stays after a delete", async () => {
  const made = await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "P3/1", invoice_date: "2026-10-20", supplier_name: "P3 Supplier", usd_rate: 385, lines: [{ product_id: p1.id, qty: 10, cost_usd: 20 }] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.data.id;
  assert.deepEqual(made.data.log.map((g) => g.action), ["create"]);
  // a PDF and a photo; a text file is refused
  const pdf = new Blob([Buffer.from("%PDF-1.4\n%fake\n")], { type: "application/pdf" });
  const png = new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], { type: "image/png" });
  const form = new FormData();
  form.append("files", pdf, "invoice.pdf");
  form.append("files", png, "paper.png");
  const up = await apiFormRequest(`/api/purchases/${id}/files`, { form, cookie: accCookie });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.deepEqual(up.data.files.map((f) => [f.original_name, f.mime]), [["invoice.pdf", "application/pdf"], ["paper.png", "image/png"]]);
  const bad = new FormData();
  bad.append("files", new Blob(["hello"], { type: "text/plain" }), "x.txt");
  assert.equal((await apiFormRequest(`/api/purchases/${id}/files`, { form: bad, cookie: accCookie })).status, 400);
  // the file opens for the managers, not for a rep
  const fileId = up.data.files[0].id;
  const got = await apiRequest(`/api/purchases/files/${fileId}`, { cookie: accCookie });
  assert.equal(got.status, 200);
  assert.equal((await apiRequest(`/api/purchases/files/${fileId}`, { cookie: repCookie })).status, 403);
  assert.equal((await apiFormRequest(`/api/purchases/${id}/files`, { form: (() => { const f = new FormData(); f.append("files", pdf, "a.pdf"); return f; })(), cookie: repCookie })).status, 403);
  // an edit: the history says what changed (the rate, the total)
  const full = (await apiRequest(`/api/purchases/${id}`, { cookie: accCookie })).data;
  const edit = await apiRequest(`/api/purchases/${id}`, { method: "PUT", cookie: accCookie, body: { ...full, usd_rate: 390, lines: [{ product_id: p1.id, qty: 12, cost_usd: 20 }] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const upd = edit.data.log.find((g) => g.action === "update");
  assert.deepEqual(upd.details.fields.usd_rate, [385, 390]);
  assert.deepEqual([upd.details.before.usd, upd.details.after.usd], [200, 240]);
  assert.ok(edit.data.log.some((g) => g.action === "file_add"));
  // remove a file: gone, and written
  assert.equal((await apiRequest(`/api/purchases/files/${fileId}`, { method: "DELETE", cookie: accCookie })).status, 204);
  const after = (await apiRequest(`/api/purchases/${id}`, { cookie: accCookie })).data;
  assert.equal(after.files.length, 1);
  assert.ok(after.log.some((g) => g.action === "file_delete"));
  // the export: one row per line with the invoice's head
  const exp = await apiRequest("/api/purchases/export.xlsx?from=2026-10-20&to=2026-10-20", { cookie: accCookie });
  assert.equal(exp.status, 200);
  // the delete keeps the history; the files are gone with the invoice
  const { rows: [{ n: filesBefore }] } = await pool.query("SELECT count(*)::int AS n FROM purchase_files WHERE invoice_id = $1", [id]);
  assert.equal(filesBefore, 1);
  const admin = await loginAs((await createUser("admin")).email);
  assert.equal((await apiRequest(`/api/purchases/${id}`, { method: "DELETE", cookie: admin })).status, 204);
  const { rows: log } = await pool.query("SELECT action FROM purchase_log WHERE invoice_id = $1 ORDER BY id", [id]);
  assert.deepEqual(log.map((g) => g.action), ["create", "file_add", "update", "file_delete", "delete"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM purchase_files WHERE invoice_id = $1", [id])).rows[0].n, 0);
});

const rawGet = (path, cookie) => fetch(`${testBaseUrl()}${path}`, { headers: { Cookie: cookie } });

test("the export is a real workbook with the invoice's lines", async () => {
  await apiRequest("/api/purchases", { method: "POST", cookie: accCookie, body: { invoice_no: "P3/2", invoice_date: "2026-10-21", supplier_name: "P3 Supplier", usd_rate: 385, lines: [{ product_id: p1.id, qty: 3, cost_usd: 7.5 }, { product_id: p2.id, qty: 2, cost_usd: 1 }] } });
  const res = await rawGet("/api/purchases/export.xlsx?from=2026-10-21&to=2026-10-21", accCookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.worksheets[0];
  assert.equal(ws.getRow(1).getCell(1).value, "Date");
  const rows = [];
  ws.eachRow((r, n) => n > 1 && rows.push([r.getCell(2).value, r.getCell(8).value, r.getCell(10).value]));
  assert.deepEqual(rows, [["P3/2", 3, 22.5], ["P3/2", 2, 2]]);
});
