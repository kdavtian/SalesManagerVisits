// "Order usual / Reorder": what a customer normally buys, built from their order history (the synced
// Excel lines plus app orders newer than the last sync) and the customer's own ordering rhythm.
//  - usual items: products in at least 2 of the last 6 orders (any product of the last order for a customer
//    with fewer than 3 orders), typical quantity = the median, flagged "due" when the product's own gap passed
//  - `from`: the lines of one past order ("erp:<order id>" or "app:<order id>") for the Reorder button
// Only products still active in the catalog can be reordered; the rest are counted in `skipped`.
import { pool } from "./db/pool.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { reorderState } from "./orderRhythm.js";

const ORDERS_CONSIDERED = 6;
const DAY_MS = 86400000;

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayNumber = (value) => Math.floor(new Date(`${String(value instanceof Date ? value.toISOString() : value).slice(0, 10)}T00:00:00Z`).getTime() / DAY_MS);

async function loadHistory(customer) {
  const orders = [];
  let lastErpDate = null;
  if (customer.erp_customer_id) {
    const { rows } = await pool.query(
      `SELECT l.order_id, l.order_date, l.product_id AS erp_pid, l.brand, l.product_name, l.size_l, l.qty
       FROM erp_order_lines l
       WHERE l.erp_customer_id = $1 AND COALESCE(l.qty, 0) > 0
         AND l.order_id IN (SELECT order_id FROM erp_order_lines WHERE erp_customer_id = $1 AND COALESCE(qty, 0) > 0
                            GROUP BY order_id, order_date ORDER BY order_date DESC, order_id DESC LIMIT $2)`,
      [customer.erp_customer_id, ORDERS_CONSIDERED]
    );
    const byOrder = new Map();
    for (const r of rows) {
      if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, { key: `erp:${r.order_id}`, date: r.order_date, lines: [] });
      byOrder.get(r.order_id).lines.push({ erp_pid: r.erp_pid, name: r.product_name, brand: r.brand, size_l: r.size_l, qty: Number(r.qty) });
    }
    orders.push(...byOrder.values());
    const { rows: [m] } = await pool.query("SELECT max(order_date) AS d FROM erp_order_lines WHERE erp_customer_id = $1", [customer.erp_customer_id]);
    lastErpDate = m?.d ?? null;
  }
  // App orders the sync has not brought back yet (placed after the last synced order day).
  const { rows: appRows } = await pool.query(
    `SELECT o.id, (o.created_at AT TIME ZONE 'Asia/Yerevan')::date AS order_date, oi.product_id, oi.product_name, oi.quantity
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = $1 AND o.status <> 'draft'
       AND ($2::date IS NULL OR (o.created_at AT TIME ZONE 'Asia/Yerevan')::date > $2::date)
     ORDER BY o.created_at DESC LIMIT 200`,
    [customer.id, lastErpDate]
  );
  const appOrders = new Map();
  for (const r of appRows) {
    if (!appOrders.has(r.id)) appOrders.set(r.id, { key: `app:${r.id}`, date: r.order_date, lines: [] });
    appOrders.get(r.id).lines.push({ product_id: r.product_id, name: r.product_name, qty: Number(r.quantity) });
  }
  orders.push(...appOrders.values());
  orders.sort((a, b) => dayNumber(b.date) - dayNumber(a.date) || b.key.localeCompare(a.key));
  return orders.slice(0, ORDERS_CONSIDERED);
}

// A past order selected by the Reorder button (may be older than the 6 considered for the usual basket).
async function loadSingleOrder(customer, from) {
  const [source, id] = String(from).split(":");
  if (source === "erp" && customer.erp_customer_id) {
    const { rows } = await pool.query(
      `SELECT order_id, order_date, product_id AS erp_pid, brand, product_name, size_l, qty FROM erp_order_lines
       WHERE erp_customer_id = $1 AND order_id = $2 AND COALESCE(qty, 0) > 0`,
      [customer.erp_customer_id, id]
    );
    if (!rows.length) return null;
    return { key: `erp:${id}`, date: rows[0].order_date, lines: rows.map((r) => ({ erp_pid: r.erp_pid, name: r.product_name, brand: r.brand, size_l: r.size_l, qty: Number(r.qty) })) };
  }
  if (source === "app" && Number.isInteger(Number(id))) {
    const { rows } = await pool.query(
      `SELECT (o.created_at AT TIME ZONE 'Asia/Yerevan')::date AS order_date, oi.product_id, oi.product_name, oi.quantity
       FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.customer_id = $1 AND o.id = $2`,
      [customer.id, Number(id)]
    );
    if (!rows.length) return null;
    return { key: `app:${id}`, date: rows[0].order_date, lines: rows.map((r) => ({ product_id: r.product_id, name: r.product_name, qty: Number(r.quantity) })) };
  }
  return null;
}

// Resolves every history line to a catalog product (active only) and returns { byLine: Map(line -> product) }.
async function mapToCatalog(orders) {
  const ids = new Set();
  const pids = new Set();
  for (const o of orders) for (const l of o.lines) {
    if (l.product_id) ids.add(Number(l.product_id));
    if (l.erp_pid) pids.add(String(l.erp_pid).toLowerCase());
  }
  const { rows } = await pool.query(
    `SELECT id, name, brand, unit, erp_product_id FROM products
     WHERE active AND (id = ANY($1::int[]) OR lower(erp_product_id) = ANY($2::text[]))`,
    [[...ids], [...pids]]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byErp = new Map(rows.filter((r) => r.erp_product_id).map((r) => [r.erp_product_id.toLowerCase(), r]));
  return (line) => (line.product_id ? byId.get(Number(line.product_id)) : byErp.get(String(line.erp_pid ?? "").toLowerCase())) ?? null;
}

export async function buildReorderProfile(customerId, { from = null, today = yerevanToday() } = {}) {
  const { rows: [customer] } = await pool.query("SELECT id, erp_customer_id FROM customers WHERE id = $1", [customerId]);
  if (!customer) return null;
  const todayNum = dayNumber(today);

  const [history, single] = await Promise.all([loadHistory(customer), from ? loadSingleOrder(customer, from) : null]);
  const resolve = await mapToCatalog(single ? [...history, single] : history);

  const { rows: [rhythm] } = customer.erp_customer_id
    ? await pool.query("SELECT last_order_date, median_gap_days FROM customer_order_rhythm WHERE erp_customer_id = $1", [customer.erp_customer_id])
    : { rows: [] };
  const lastOrderDay = history.length ? dayNumber(history[0].date) : null;
  const daysSince = lastOrderDay === null ? null : todayNum - lastOrderDay;
  const gap = rhythm?.median_gap_days ?? null;
  const state = reorderState(daysSince, gap);

  // Usual basket: per product over the considered orders.
  const stats = new Map();
  for (const o of history) {
    const seen = new Set();
    for (const l of o.lines) {
      const product = resolve(l);
      const key = product ? `p${product.id}` : `x:${String(l.erp_pid ?? l.name).toLowerCase()}`;
      if (seen.has(key)) continue; // a product on two lines of one order counts once
      seen.add(key);
      const qty = o.lines.filter((x) => resolve(x)?.id === product?.id && (product || x === l)).reduce((n, x) => n + x.qty, 0);
      if (!stats.has(key)) stats.set(key, { product, name: l.name, qtys: [], days: [] });
      const st = stats.get(key);
      st.qtys.push(qty);
      st.days.push(dayNumber(o.date));
    }
  }
  const minOccurrences = history.length >= 3 ? 2 : 1;
  const items = [];
  let skipped = 0;
  for (const st of stats.values()) {
    if (st.qtys.length < minOccurrences) continue;
    if (!st.product) {
      skipped++;
      continue;
    }
    const days = [...st.days].sort((a, b) => b - a); // newest first
    const gaps = days.slice(1).map((d, i) => days[i] - d).filter((g) => g > 0);
    const itemGap = gaps.length ? median(gaps) : null;
    const sinceItem = todayNum - days[0];
    const itemDue = itemGap ? sinceItem >= itemGap * 0.9 : state !== null;
    items.push({
      product_id: st.product.id,
      name: st.product.name,
      brand: st.product.brand,
      unit: st.product.unit,
      quantity: Math.max(1, Math.round(median(st.qtys))),
      times: st.qtys.length,
      last_ordered_days: sinceItem,
      due: itemDue,
    });
  }
  items.sort((a, b) => Number(b.due) - Number(a.due) || b.times - a.times || a.name.localeCompare(b.name));

  const profile = {
    cadence: { median_gap_days: gap, days_since_order: daysSince, state },
    orders_considered: history.length,
    items,
    skipped,
    lines: null,
  };
  if (single) {
    const lines = [];
    let notAvailable = 0;
    for (const l of single.lines) {
      const product = resolve(l);
      if (!product) notAvailable++;
      else lines.push({ product_id: product.id, name: product.name, quantity: Math.max(1, Math.round(l.qty)) });
    }
    profile.lines = { source: single.key, date: single.date, lines, not_available: notAvailable };
  }
  return profile;
}

// The customer's last few orders (newest first: Excel history plus app orders the sync has not brought back yet) with
// their lines -- for the "Repeat order" picker of the order menu. Same data (and same RBAC) as the reorder profile.
export async function recentOrdersFor(customerId) {
  const { rows: [customer] } = await pool.query("SELECT id, erp_customer_id FROM customers WHERE id = $1", [customerId]);
  if (!customer) return null;
  const history = await loadHistory(customer);
  return history.map((o) => ({
    key: o.key,
    date: String(o.date instanceof Date ? o.date.toISOString() : o.date).slice(0, 10),
    lines: o.lines.map((l) => ({ name: [l.brand, l.name].filter(Boolean).join(" "), qty: l.qty })),
  }));
}
