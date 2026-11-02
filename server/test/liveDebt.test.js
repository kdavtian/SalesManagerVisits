// The live debt (payments redesign, release 3c): Excel debt + app orders not in Excel - app payments not in Excel; the oldest orders are
// paid first, Excel and app alike; paying more than owed is an advance.
import test from "node:test";
import assert from "node:assert/strict";
import { liveDebtOf, liveSummary } from "../src/money/liveDebt.js";

const excelOrders = [
  { order_id: "E3", date: "2026-10-20", total: 100000 },
  { order_id: "E2", date: "2026-09-20", total: 100000 },
  { order_id: "E1", date: "2026-08-20", total: 100000 },
];
const today = "2026-11-02";

test("an app payment the Excel does not have yet pays the OLDEST unpaid order first", () => {
  // Excel: 150,000 owed = E3 (100k) + half of E2; the rep collected 60,000 today
  const live = liveDebtOf({ excelDebt: 150000, excelOrders, adj: { orders: [], orders_amd: 0, payments_amd: 60000 }, today, termDays: 30 });
  assert.equal(live.debt_amd, 90000);
  assert.equal(live.excel_amd, 150000);
  const unpaid = Object.fromEntries(live.aging.invoices.map((i) => [i.order_id, i.unpaid]));
  assert.deepEqual(unpaid, { E3: 90000 }, "E2 is paid off, E3 partly");
});

test("an app order not in the Excel adds to the debt and is the newest unpaid; overpaying leaves an advance", () => {
  const adj = { orders: [{ order_id: "app-7", app_order_id: 7, date: "2026-11-01", total: 40000 }], orders_amd: 40000, payments_amd: 0 };
  const live = liveDebtOf({ excelDebt: 50000, excelOrders, adj, today, termDays: 30 });
  assert.equal(live.debt_amd, 90000);
  assert.deepEqual(live.aging.invoices.map((i) => [i.order_id, i.unpaid]), [["app-7", 40000], ["E3", 50000]]);
  const over = liveDebtOf({ excelDebt: 20000, excelOrders, adj: { orders: [], orders_amd: 0, payments_amd: 50000 }, today });
  assert.equal(over.debt_amd, 0);
  assert.equal(over.advance_amd, 30000);
  assert.equal(liveSummary(over).unpaid_orders, 0);
});

test("no Excel figure: nothing is computed", () => {
  assert.equal(liveDebtOf({ excelDebt: null, excelOrders, adj: undefined, today }), null);
});
