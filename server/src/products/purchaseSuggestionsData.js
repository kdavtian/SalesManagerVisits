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
import { incomingLotsByProduct, productHistory } from "./purchases.js";
import { orderStep, purchaseLine, sizeLiters } from "./purchaseSuggestion.js";
import { yerevanToday } from "../utils/yerevanDate.js";

const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** `what`: { leadDays, coverDays } to try other numbers than the settings (the screen's "what if"; owner, 2026-11-26); the settings stay. */
export async function buildPurchaseSuggestions(db = pool, today = yerevanToday(), what = {}) {
  const { rows } = await db.query(
    `WITH sel AS (SELECT p.id FROM products p WHERE p.active),
     ${stockFigureCtes("sel")},
     demand AS (
       SELECT product_id, SUM(qty) FILTER (WHERE order_date >= $1::date - 90) AS qty_90d, MAX(order_date) AS last_sale_date
       FROM erp_order_lines WHERE product_id IS NOT NULL GROUP BY product_id
     )
     SELECT p.id, p.erp_product_id, p.sku, p.name, COALESCE(NULLIF(p.silver_price_amd, 0), NULLIF(p.unit_price_amd, 0)) AS price_amd, p.brand, p.family, p.unit, p.size_l, p.items_per_pack, p.stock_qty, p.created_at,
            d.qty_90d, d.last_sale_date, ${STOCK_FIGURE_COLUMNS}
     FROM products p ${STOCK_FIGURE_JOINS} LEFT JOIN demand d ON d.product_id = p.erp_product_id
     WHERE p.active AND p.stock_qty IS NOT NULL`,
    [today]
  );
  // customers' wishes of the last 180 days (owner 2026-11-26, plan step 10; orders/productWishes.js): a catalog product they still wait for
  // (not back in stock yet) is bought on top; a product we do not carry at all is a "new product" candidate on the screen
  const WISH_DAYS = 180;
  const [demand, settings, incoming, { rows: transporters }, { rows: wishRows }, { rows: candidateRows }] = await Promise.all([
    loadDemandInputs(db, today), getDemandSettings(db), incomingLotsByProduct(db),
    db.query("SELECT name, goods_from FROM suppliers WHERE goods_from IS NOT NULL AND trim(goods_from) <> ''"),
    db.query(
      `SELECT product_id, SUM(quantity)::int AS qty, COUNT(DISTINCT customer_id)::int AS customers
         FROM product_wishes WHERE product_id IS NOT NULL AND back_in_stock_at IS NULL AND created_at >= $1::date - $2::int
        GROUP BY product_id`,
      [today, WISH_DAYS]
    ),
    db.query(
      `SELECT min(trim(custom_name)) AS name, SUM(quantity)::int AS qty, COUNT(DISTINCT customer_id)::int AS customers,
              to_char(max(created_at AT TIME ZONE 'Asia/Yerevan'), 'YYYY-MM-DD') AS last_day
         FROM product_wishes WHERE product_id IS NULL AND custom_name IS NOT NULL AND trim(custom_name) <> '' AND created_at >= $1::date - $2::int
        GROUP BY lower(regexp_replace(trim(custom_name), '\\s+', ' ', 'g'))
        ORDER BY COUNT(DISTINCT customer_id) DESC, SUM(quantity) DESC, min(trim(custom_name)) LIMIT 50`,
      [today, WISH_DAYS]
    ),
  ]);
  // a transporter's invoices are the real supplier's goods (owner, 2026-11-26: Sole Trans brings Castrol): grouped under the real supplier
  const goodsFrom = new Map(transporters.map((r) => [String(r.name).replace(/\s+/g, " ").trim().toLowerCase(), String(r.goods_from).replace(/\s+/g, " ").trim()]));
  const days = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365 ? Number(v) : null);
  const lead = days(what.leadDays) ?? settings.leadTimeDays;
  const cover = days(what.coverDays) ?? settings.coverDays;
  // all = every product a supplier sells us, also those that need nothing now (owner 2026-11-27: New purchase -> choose the supplier ->
  // all its products, quantities filled by the AI button); supplier = only that supplier's card
  const all = Boolean(what.all);
  const onlySupplier = what.supplier == null || what.supplier === "" ? null : String(what.supplier).replace(/\s+/g, " ").trim().toLowerCase();

  const wishes = new Map(wishRows.map((r) => [r.product_id, { qty: r.qty, customers: r.customers }]));
  const lines = [];
  for (const row of rows) {
    const free = Number(row.stock_qty) - row.held_qty + row.back_on_shelf_qty;
    const lots = incoming.get(row.id) ?? [];
    const coming = lots.reduce((a, l) => a + l.qty, 0);
    const forecast = computeDemandForecast({
      leadTimeDays: lead, serviceZ: settings.serviceZ, reviewDays: cover,
      weeklyQty: demand.weekly.get(row.erp_product_id) ?? [], stockQty: free + coming, reservedQty: row.submitted_qty,
      lastSaleDate: row.last_sale_date, createdAt: row.created_at, today,
    });
    const daily = forecast.dailyDemand ?? (Number(row.qty_90d) || 0) / 90;
    // a product with free stock again is serving its wishes (back_in_stock_at is set only by the next Excel sync): not counted on top,
    // or a wisher's submitted order would be counted twice (review 2026-11-27)
    const wished = free > 0 ? null : wishes.get(row.id);
    if (!all && !(daily > 0) && !wished) continue;
    const step = orderStep(row);
    const line = purchaseLine({ stockNow: free, comingLots: lots, wanted: row.submitted_qty, daily, leadTimeDays: lead, coverDays: cover, safetyStock: forecast.safetyStock ?? 0, stepPieces: step.stepPieces, trend: forecast.trend, wished: wished?.qty ?? 0 });
    if (!all && !(line.suggested > 0)) continue;
    lines.push({
      product_id: row.id, // the SKU column of the Excel (synced); no SKU = an empty cell, never the product id (owner 2026-11-27)
      sku: row.sku || null, name: row.name,
      // our selling price (Silver, else the base price): what the lost sales are worth
      price_amd: row.price_amd == null ? null : Number(row.price_amd), brand: row.brand, family: row.family, unit: row.unit,
      liters_per_piece: sizeLiters(row), kind: step.kind, pack_size: step.packSize, step_pieces: step.stepPieces, pack_size_guessed: step.packSizeGuessed,
      stock_now: Math.max(0, Math.round(free)), coming: Math.round(coming), wanted: row.submitted_qty, daily_demand: Math.round(daily * 100) / 100,
      // the exact inputs: the phone recomputes a line after − / + from these, so it agrees with this suggestion to the piece (review 2026-11-25)
      free_raw: free, coming_lots: lots, daily_raw: daily,
      safety_stock: forecast.safetyStock ?? 0, trend: forecast.trend, status: forecast.status, wished_customers: wished?.customers ?? 0,
      ...line,
    });
  }

  // the supplier each product was last bought from, and its last price per piece (100 products a call: productHistory's limit)
  const history = {};
  const ids = lines.map((l) => l.product_id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const part of await Promise.all(chunks.map((c) => productHistory(c, {}, db)))) Object.assign(history, part);
  // one card per supplier however its name was typed ("Total Oil" / "TOTAL OIL "): the first spelling met is shown (review 2026-11-25);
  // a transporter's lines go to the company the goods come from, the transporter kept as `via`
  const bySupplier = new Map();
  const shown = new Map();
  const viaOf = new Map();
  for (const l of lines) {
    const last = history[l.product_id]?.last ?? null;
    const written = String(last?.supplier ?? "").replace(/\s+/g, " ").trim();
    const real = goodsFrom.get(written.toLowerCase());
    const raw = real ?? written;
    const key = raw.toLowerCase();
    if (real) {
      l.via = written;
      if (!viaOf.has(key)) viaOf.set(key, new Set());
      viaOf.get(key).add(written);
    }
    if (!shown.has(key)) shown.set(key, raw);
    l.supplier = shown.get(key);
    l.cost_usd = last?.cost_usd ?? null;
    l.last_bought = last?.day ?? null;
    if (!bySupplier.has(l.supplier)) bySupplier.set(l.supplier, []);
    bySupplier.get(l.supplier).push(l);
  }
  // all products: only those with a supplier to buy them from (never bought = no supplier, nothing to order from)
  if (all) bySupplier.delete("");
  if (onlySupplier != null) for (const key of [...bySupplier.keys()]) if (String(key).toLowerCase() !== onlySupplier) bySupplier.delete(key);
  const suppliers = [...bySupplier.entries()].map(([supplier, list]) => {
    // the most urgent first: runs out before the goods could come, then the fewest days left
    list.sort((a, b) => Number(b.runs_out_before_arrival) - Number(a.runs_out_before_arrival) || (a.days_now ?? Infinity) - (b.days_now ?? Infinity));
    return { supplier, via: [...(viaOf.get(String(supplier ?? "").toLowerCase()) ?? [])], lines: list, totals: supplierTotals(list) };
  });
  // suppliers by money, the products with no known supplier last
  suppliers.sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || b.totals.usd - a.totals.usd);
  return {
    today, lead_time_days: lead, cover_days: cover, settings_lead_days: settings.leadTimeDays, settings_cover_days: settings.coverDays,
    arrival_date: addDays(today, lead), suppliers,
    // products we do not carry that customers asked for (not orderable here; for the assortment decision)
    new_candidates: candidateRows.map((r) => ({ name: r.name, qty: r.qty, customers: r.customers, last_day: r.last_day })),
  };
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
