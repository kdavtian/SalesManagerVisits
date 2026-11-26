// The product card's Market section (owner, 2026-11-26): for one product, what the field data says about it --
//   - shelf: how many visited shops had it in stock (checkins.available_products, latest assortment check per shop, <= 60 days)
//   - competitors: the brands of the same line and volume with their median prices (Competitor prices report, clean, 90 days)
//   - wishes: customers who asked for it (product_wishes, 90 days)
//   - potential: the litres a month our customers could use on its line (volume potential)
//   - lost sales: when out of stock, the monthly sales it usually makes (Excel, last 3 whole months) and since when it is out
import { pool } from "../../db/pool.js";
import { SHELF_FRESH_DAYS } from "../../field/shelfData.js";
import { loadPriceEntries } from "./marketPrices.js";
import { buildIndex, ourProducts, marketLines } from "./priceIndex.js";

export const WISH_DAYS = 90;
const SALES_MONTHS = 3;

export async function productMarket(productId, { now = new Date(), db = pool } = {}) {
  const { rows: [p] } = await db.query(
    `SELECT id, name, erp_product_id, stock_qty, stock_changed_at FROM products WHERE id = $1`,
    [productId]
  );
  if (!p) return null;
  const [mine] = await ourProducts(db, { productId });
  const freshSince = new Date(now.getTime() - SHELF_FRESH_DAYS * 86400000);
  const wishSince = new Date(now.getTime() - WISH_DAYS * 86400000);
  const [shelf, wishes, sales, potential, competitors] = await Promise.all([
    // per shop the latest visit that ticked its usual products in stock; does that list name this product
    db.query(
      `SELECT count(*)::int AS checked, count(*) FILTER (WHERE has)::int AS on_shelf, max(at) AS latest_at
       FROM (SELECT DISTINCT ON (ch.customer_id) ch.customer_id, ch.timestamp AS at,
                    EXISTS (SELECT 1 FROM unnest(ch.available_products) v WHERE lower(trim(v)) = lower(trim($1))) AS has
             FROM checkins ch
             WHERE ch.available_products IS NOT NULL AND ch.timestamp >= $2
             ORDER BY ch.customer_id, ch.timestamp DESC, ch.id DESC) s`,
      [p.name, freshSince]
    ),
    db.query(
      `SELECT count(DISTINCT customer_id)::int AS customers, COALESCE(sum(quantity), 0)::int AS quantity, max(created_at) AS latest_at
       FROM product_wishes WHERE product_id = $1 AND created_at >= $2`,
      [p.id, wishSince]
    ),
    p.erp_product_id
      ? db.query(
          `SELECT COALESCE(sum(qty), 0)::float8 AS qty, count(DISTINCT erp_customer_id)::int AS customers
           FROM erp_order_lines
           WHERE lower(trim(product_id)) = lower(trim($1)) AND erp_customer_id <> '10000'
             AND order_date >= (date_trunc('month', (now() AT TIME ZONE 'Asia/Yerevan')) - interval '${SALES_MONTHS} months')::date
             AND order_date < date_trunc('month', (now() AT TIME ZONE 'Asia/Yerevan'))::date`,
          [p.erp_product_id]
        )
      : { rows: [{ qty: 0, customers: 0 }] },
    mine
      ? db.query(
          `SELECT COALESCE(sum(a.amount_month), 0)::float8 AS litres, count(DISTINCT a.customer_id)::int AS customers
           FROM volume_potential_amounts a JOIN volume_potential_lines l ON l.id = a.line_id
           JOIN customers c ON c.id = a.customer_id AND c.closed_at IS NULL
           WHERE l.code = $1 AND a.amount_month > 0`,
          [mine.line_code]
        )
      : { rows: [null] },
    mine ? Promise.all([loadPriceEntries({ until: now, db }), marketLines(db)]) : null,
  ]);
  let line = null;
  if (mine && competitors) {
    const [entries, lines] = competitors;
    const info = lines.find((l) => l.code === mine.line_code);
    const index = buildIndex(entries, [mine], { now, lines });
    const g = index.groups.find((x) => x.line_code === mine.line_code && Math.abs(x.volume - mine.volume) < 0.001);
    line = {
      code: mine.line_code,
      name_en: info?.name_en ?? mine.line_code,
      name_hy: info?.name_hy ?? mine.line_code,
      unit: info?.unit ?? "L",
      volume: mine.volume,
      potential_litres: Math.round(potential.rows[0]?.litres ?? 0),
      potential_customers: potential.rows[0]?.customers ?? 0,
      competitors: (g?.brands ?? []).map((b) => ({ brand_key: b.brand_key, brand_name: b.brand_name, wholesale: b.wholesale, retail: b.retail, gap_wholesale_pct: b.gap_wholesale_pct, gap_retail_pct: b.gap_retail_pct, shops: b.meta.shops, latest_at: b.meta.latest_at })),
    };
  }
  const s = shelf.rows[0];
  const w = wishes.rows[0];
  const monthly = Math.round((sales.rows[0].qty / SALES_MONTHS) * 10) / 10;
  const out = p.stock_qty != null && Number(p.stock_qty) <= 0;
  return {
    product_id: p.id,
    shelf: { checked: s.checked, on_shelf: s.on_shelf, latest_at: s.latest_at, fresh_days: SHELF_FRESH_DAYS },
    wishes: { customers: w.customers, quantity: w.quantity, latest_at: w.latest_at, days: WISH_DAYS },
    sales: { monthly_qty: monthly, customers: sales.rows[0].customers, months: SALES_MONTHS },
    line,
    out_of_stock: out ? { since: p.stock_changed_at, monthly_qty: monthly, litres: line ? Math.round(monthly * line.volume) : null, wish_customers: w.customers } : null,
  };
}
