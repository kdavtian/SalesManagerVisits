// Generic table -> Excel endpoint used by the Sales / Payments export icon.
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startTestServer, stopTestServer, cleanupAll, createUser, loginAs, apiRequest } from "./helpers.js";

let cookie;
let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
  const user = await createUser("sales_director");
  cookie = await loginAs(user.email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("POST /api/table-export/xlsx returns a workbook with typed columns; rejects bad input and anonymous callers", async () => {
  const payload = {
    filename: "payments 2026-10-01",
    sheet: "Payments",
    columns: [{ header: "Date" }, { header: "Amount", type: "number" }],
    rows: [["2026-10-01", 1500000], ["2026-10-02", "=1+1"]],
  };
  const anon = await apiRequest("/api/table-export/xlsx", { method: "POST", body: payload });
  assert.equal(anon.status, 401);
  const bad = await apiRequest("/api/table-export/xlsx", { method: "POST", cookie, body: { columns: [], rows: [] } });
  assert.equal(bad.status, 400);

  const res = await fetch(`${baseUrl}/api/table-export/xlsx`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": cookie.match(/csrf_token=([^;]+)/)[1] }, body: JSON.stringify(payload) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /payments_2026-10-01\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet("Payments");
  assert.equal(ws.getRow(1).getCell(2).value, "Amount");
  assert.equal(ws.getRow(2).getCell(2).value, 1500000);
  assert.equal(ws.getRow(3).getCell(1).value, "2026-10-02");
  // Text stays text (no formula evaluation of "=1+1" in a number column -> null).
  assert.equal(ws.getRow(3).getCell(2).value, null);
});
