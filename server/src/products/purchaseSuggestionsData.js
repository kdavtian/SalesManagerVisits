// Smart purchase suggestions, the data (owner, 2026-11-25): every active product that needs buying, with the numbers of
// client/public/js/shared/purchaseSuggestion.js (stock now, on the way, days left, the order in whole steps, stock and days left after
// receiving), grouped by the supplier it was last bought from (the app's purchases, else the Excel Purchase_IN) with its last price.
//
// Stock now = FREE stock (orders/appStock.js: Excel − held by orders + back on the shelf not in Excel yet). Sales a day come from the demand
// model (demandModel.js: weighted weekly Excel sales, damped spikes, Croston for lumpy sales, safety stock at the service level); a product
// out of stock with no model estimate falls back to its last 90 days' sales. Lead time and cover days are the admin's settings
// (demandSettings.js). A purchase line's quantity and price are per piece (the Excel's "pack" = one bottle).
import { pool } from "../db/pool.js";
import { stockFigureCtes, STOCK_FIGURE_JOINS, STOCK_FIGURE_COLUMNS } from "../orders/appStock.js";
import { computeDemandForecast } from "./demandModel.js";
import { getDemandSettings } from "./demandSettings.js";
import { loadDemandInputs } from "./demandInputs.js";
import { incomingQtyByProduct, productHistory } from "./purchases.js";
import { orderStep, purchaseLine, sizeLiters } from "./purchaseSuggestion.js";
import { yerevanToday } from "../utils/yerevanDate.js";

const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function buildPurchaseSuggestions(db = pool, today = yerevanToday()) {
  const { rows } = await db.query(
    `WITH sel AS (SELECT p.id FROM products p WHERE p.active),
     ${stockFigureCtes("sel")},
     demand AS (
       SELECT product_id, SUM(qty) FILTER (WHERE order_date >= $1::date - 90) AS qty_90d, MAX(order_date) AS last_sale_date
       FROM erp_order_lines WHERE product_id IS NOT NULL GROUP BY product_id
     )
     SELECT p.id, p.erp_product_id, p.name, p.brand, p.family, p.unit, p.size_l, p.items_per_pack, p.stock_qty, p.created_at,
            d.qty_90d, d.last_sale_date, ${STOCK_FIGURE_COLUMNS}
     FROM products p ${STOCK_FIGURE_JOINS} LEFT JOIN demand d ON d.product_id = p.erp_product_id
     WHERE p.active AND p.stock_qty IS NOT NULL`,
    [today]
  );
  const [demand, settings, incoming] = await Promise.all([loadDemandInputs(db, today), getDemandSettings(db), incomingQtyByProduct(db)]);
  const lead = settings.leadTimeDays;
  const cover = settings.coverDays;

  const lines = [];
  for (const row of rows) {
    const free = Number(row.stock_qty) - row.held_qty + row.back_on_shelf_qty;
    const coming = incoming.get(row.id) ?? 0;
    const forecast = computeDemandForecast({
      leadTimeDays: lead, serviceZ: settings.serviceZ, reviewDays: cover,
      weeklyQty: demand.weekly.get(row.erp_product_id) ?? [], stockQty: free + coming, reservedQty: row.submitted_qty,
      lastSaleDate: row.last_sale_date, createdAt: row.created_at, today,
    });
    const daily = forecast.dailyDemand ?? (Number(row.qty_90d) || 0) / 90;
    if (!(daily > 0)) continue;
    const step = orderStep(row);
    const line = purchaseLine({ stockNow: free, coming, wanted: row.submitted_qty, daily, leadTimeDays: lead, coverDays: cover, safetyStock: forecast.safetyStock ?? 0, stepPieces: step.stepPieces });
    if (!(line.suggested > 0)) continue;
    lines.push({
      product_id: row.id, name: row.name, brand: row.brand, family: row.family, unit: row.unit,
      liters_per_piece: sizeLiters(row), kind: step.kind, pack_size: step.packSize, step_pieces: step.stepPieces, pack_size_guessed: step.packSizeGuessed,
      stock_now: Math.max(0, Math.round(free)), coming: Math.round(coming), wanted: row.submitted_qty, daily_demand: Math.round(daily * 100) / 100,
      safety_stock: forecast.safetyStock ?? 0, trend: forecast.trend, status: forecast.status,
      ...line,
    });
  }

  // the supplier each product was last bought from, and its last price per piece (100 products a call: productHistory's limit)
  const history = {};
  const ids = lines.map((l) => l.product_id);
  for (let i = 0; i < ids.length; i += 100) Object.assign(history, await productHistory(ids.slice(i, i + 100), {}, db));
  const bySupplier = new Map();
  for (const l of lines) {
    const last = history[l.product_id]?.last ?? null;
    l.supplier = last?.supplier ?? "";
    l.cost_usd = last?.cost_usd ?? null;
    l.last_bought = last?.day ?? null;
    if (!bySupplier.has(l.supplier)) bySupplier.set(l.supplier, []);
    bySupplier.get(l.supplier).push(l);
  }
  const suppliers = [...bySupplier.entries()].map(([supplier, list]) => {
    // the most urgent first: runs out before the goods could come, then the fewest days left
    list.sort((a, b) => Number(b.runs_out_before_arrival) - Number(a.runs_out_before_arrival) || (a.days_now ?? 0) - (b.days_now ?? 0));
    return { supplier, lines: list, totals: supplierTotals(list) };
  });
  // suppliers by money, the products with no known supplier last
  suppliers.sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || b.totals.usd - a.totals.usd);
  return { today, lead_time_days: lead, cover_days: cover, arrival_date: addDays(today, lead), suppliers };
}

/** Pieces, litres and dollars (at the last price; products never bought have none) of a supplier's lines. */
export function supplierTotals(list) {
  let pieces = 0;
  let liters = 0;
  let usd = 0;
  let unpriced = 0;
  for (const l of list) {
    pieces += l.order;
    if (l.liters_per_piece) liters += l.liters_per_piece * l.order;
    if (l.cost_usd != null) usd += l.cost_usd * l.order;
    else if (l.order > 0) unpriced += 1;
  }
  return { products: list.filter((l) => l.order > 0).length, pieces, liters: Math.round(liters * 10) / 10, usd: round2(usd), unpriced };
}
