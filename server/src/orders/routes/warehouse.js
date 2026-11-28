// Warehouse Manager screens: an Aggregated Pick List (grouped by product,
// across every order currently sitting "confirmed" -- not scoped to one
// day, since orders arrive continuously), a Per-Order Staging List (one
// order per row, "Mark Packed" / "Flag stock issue"), and a read-only
// live-inventory reference panel. See
// migrations/051_warehouse_delivery_v3.sql for the 5-state status machine
// this operates on.
import { syncOrderPostSoon } from "../orderGroupPost.js";
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canManageWarehouse } from "../../shared/roles.js";
import { notifyUser } from "../../shared/notifications.js";
import { STOCK_ISSUE_NOTIFY_ROLES, WAREHOUSE_NOTIFY_ROLES } from "../../shared/notificationPreferences.js";
import { roundToPacks, packRule } from "../../products/stockForecast.js";
import { incomingLotsByProduct } from "../../products/purchases.js";
import { purchaseLine } from "../../products/purchaseSuggestion.js";
import { computeDemandForecast } from "../../products/demandModel.js";
import { getDemandSettings } from "../../products/demandSettings.js";
import { loadDemandInputs } from "../../products/demandInputs.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { displayNetCost } from "../discountPolicy.js";
import { getAppOrderSettings } from "../appOrders.js";
import { orderWaiting } from "../../reports/opsReports.js";
import { stockCountToday } from "../stockCount.js";
import { APP_STOCK_SQL, stockFigureCtes, STOCK_FIGURE_JOINS, STOCK_FIGURE_COLUMNS } from "../appStock.js";
import { NOT_ON_OPEN_ROUTE_SQL, LATEST_STOP_OF_DAY_SQL } from "../routeStops.js";
import { WITHDRAW_WAITING_REQUEST_SQL } from "../accountingStatus.js";


export const warehouseRouter = Router();
warehouseRouter.use(requireAuth);

// Backs the badge on the Home tab's Warehouse icon -- how many orders are
// sitting confirmed, awaiting packing (the same queue staging-list below
// shows). Declared ahead of the requireWarehouse gate below (and returns
// {count: 0} rather than 403) so it's safe to poll unconditionally the
// same way orders.js's own pending-count is, without every screen having
// to know who's allowed to see it first.
warehouseRouter.get("/pending-count", async (req, res) => {
  if (!canManageWarehouse(req.user.role)) return res.json({ count: 0 });
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'confirmed'");
  res.json({ count: rows[0].count });
});

function requireWarehouse(req, res, next) {
  if (!canManageWarehouse(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}
warehouseRouter.use(requireWarehouse);

// The warehouse manager's new Home (owner, 2026-10-23): what to do now, and what is going wrong -- one request, numbers only.
// Waiting times and limits come from the same order-flow numbers the Operations control page uses (Vaghinak's SLA settings).
warehouseRouter.get("/home", async (req, res) => {
  const today = yerevanToday();
  // every number in parallel: the screen waits for the slowest query, not for their sum
  const [{ list }, count, { rows: shortage }, { rows: [unrouted] }, { rows: [stops] }, { rows: [stale] }, { rows: [tasks] }, { rows: [returns] }] = await Promise.all([
    orderWaiting(),
    stockCountToday(pool, today).catch((err) => (console.error("Stock count numbers failed:", err.message), null)),
    // confirmed orders to pack against what is on the SHELF (appStock.js APP_STOCK_SQL: the Excel stock minus what was packed out or delivered
    // and is not in the Excel yet, plus returns and purchases back on the shelf) -- the raw Excel number still counted goods already gone
    pool.query(
      `SELECT x.product_name, x.brand, x.need, x.have, x.orders FROM (
         SELECT oi.product_name, oi.brand, SUM(oi.quantity)::int AS need, ${APP_STOCK_SQL}::int AS have, COUNT(DISTINCT oi.order_id)::int AS orders
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
         WHERE o.status = 'confirmed' AND o.cancelled_at IS NULL AND p.stock_qty IS NOT NULL
         GROUP BY p.id, oi.product_name, oi.brand) x
       WHERE x.need > x.have
       ORDER BY x.need - x.have DESC`
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE o.status = 'packed_stock_out' AND ${NOT_ON_OPEN_ROUTE_SQL}`),
    pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE rs.completed_at IS NOT NULL)::int AS done
       FROM route_stops rs JOIN delivery_routes r ON r.id = rs.route_id WHERE r.route_date = $1 AND ${LATEST_STOP_OF_DAY_SQL}`,
      [today]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM route_stops rs JOIN delivery_routes r ON r.id = rs.route_id WHERE rs.completed_at IS NULL AND r.route_date < $1`, [today]),
    pool.query(
      `SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE due_date < $2)::int AS overdue FROM tasks WHERE assignee_id = $1 AND status = 'open'`,
      [req.user.id, today]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM order_returns WHERE status = 'approved'`),
  ]);
  const pack = list.filter((w) => w.step === "pack");
  const deliver = list.filter((w) => w.step === "deliver");
  const hours = (rows) => (rows.length ? Math.max(...rows.map((w) => w.waiting_h)) : 0);
  res.json({
    to_pack: { count: pack.length, over_sla: pack.filter((w) => w.over_sla).length, app: pack.filter((w) => w.via_app).length, oldest_h: hours(pack), blocked: pack.filter((w) => w.blocked_by).length },
    packed: { count: deliver.length, over_sla: deliver.filter((w) => w.over_sla).length, unrouted: unrouted.n, oldest_h: hours(deliver) },
    shortage: { products: shortage.length, orders: shortage.reduce((n, r) => Math.max(n, r.orders), 0), sample: shortage.slice(0, 3) },
    today: { stops: stops.total, done: stops.done },
    stale_stops: stale.n,
    tasks: { open: tasks.open, overdue: tasks.overdue },
    returns_to_receive: returns.n,
    stock_count: count,
  });
});

// Grouped by product, not date -- a Warehouse Manager physically walking
// the floor needs "how many of X do I need across every order waiting
// right now", not one order at a time.
warehouseRouter.get("/pick-list", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT oi.product_id, oi.product_name, oi.brand, pr.unit AS size, pr.family,
            SUM(oi.quantity)::int AS total_quantity,
            COUNT(DISTINCT oi.order_id)::int AS order_count,
            -- on the shelf now (appStock.js APP_STOCK_SQL), not the raw Excel number: what the WM can actually pick
            (SELECT ${APP_STOCK_SQL} FROM products p WHERE p.id = oi.product_id)::int AS stock_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products pr ON pr.id = oi.product_id
     WHERE o.status = 'confirmed' AND o.cancelled_at IS NULL
     GROUP BY oi.product_id, oi.product_name, oi.brand, pr.unit, pr.family
     ORDER BY oi.brand NULLS LAST, oi.product_name`
  );
  res.json(rows);
});

// One row per order awaiting packing -- the screen a WM actually stages
// against, with "Mark Packed" / "Flag stock issue" per order.
warehouseRouter.get("/staging-list", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.total_amd, o.created_at, o.customer_id, o.placed_via_app, o.promised_date,
            c.name AS customer_name, c.erp_customer_id, c.address,
            u.name AS rep_name,
            COALESCE((SELECT MIN(changed_at) FROM order_status_history WHERE order_id = o.id AND new_status = 'confirmed'), o.updated_at) AS confirmed_at
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN users u ON u.id = o.user_id
     WHERE o.status = 'confirmed'
     ORDER BY ${(await getAppOrderSettings()).priority_enabled ? "o.placed_via_app DESC, " : ""}o.created_at ASC`
  );
  const orderIds = rows.map((r) => r.id);
  const { rows: items } = orderIds.length
    ? await pool.query(
        "SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1) ORDER BY oi.id",
        [orderIds]
      )
    : { rows: [] };
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push(item);
  }
  res.json(rows.map((o) => ({ ...o, items: itemsByOrder.get(o.id) || [] })));
});

// Packed orders waiting for the driver (read-only, for the new Pack screen's "Packed" tab): when each was packed, and whether it is on a route yet.
warehouseRouter.get("/packed-list", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.total_amd, o.placed_via_app, c.name AS customer_name, c.address,
            COALESCE((SELECT MIN(changed_at) FROM order_status_history WHERE order_id = o.id AND new_status = 'packed_stock_out'), o.updated_at) AS packed_at,
            r.route_date::text AS route_date, d.name AS driver_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN route_stops rs ON rs.order_id = o.id AND rs.completed_at IS NULL
     LEFT JOIN delivery_routes r ON r.id = rs.route_id
     LEFT JOIN users d ON d.id = r.driver_id
     WHERE o.status = 'packed_stock_out'
     ORDER BY packed_at ASC`
  );
  res.json(rows);
});

// Read-only live-inventory reference -- out of scope to decrement stock in
// real time (per spec), this is just "what does the catalog currently say
// we have" so a WM can sanity-check before flagging a stock issue.
//
// Each row is also annotated with a "days of stock left" estimate (see
// ../../products/demandModel.js for the model) built from the product's real ERP
// sales history in erp_order_lines -- the actual invoiced sales record,
// not just in-app draft orders, which only cover a slice of real demand.
// stock_status buckets that into 'out' | 'dead' | 'new' | 'slow' |
// 'critical' | 'low' | 'ok' | 'unknown'; the `stock` filter below maps
// those down to the three buckets a WM actually filters by.
warehouseRouter.get("/inventory", async (req, res) => {
  const { q, brand, size, stock } = req.query;
  // `active` matters here the same way it does for the main product
  // catalog (GET /products -- "WHERE p.active"): a product an admin has
  // deactivated (superseded by a re-import, a corrected duplicate, a
  // discontinued SKU) must not still show up on the warehouse floor --
  // this was missing entirely, which is exactly what made a stale/
  // deactivated row look like a duplicate of its live replacement.
  const conditions = ["p.active"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length})`);
  }
  if (brand) {
    params.push(brand);
    conditions.push(`p.brand = $${params.length}`);
  }
  if (size) {
    // Matched case/whitespace-insensitively, not by exact string: the
    // ERP-sourced unit column has the same "1l" / "1L" / "1 L" spelling
    // drift normalizeUnitLabel's display cleanup exists for (see
    // productSort.js) -- an exact match would otherwise split one real
    // size into several filter options that all show the same normalized
    // label, with no way to tell them apart in the sheet.
    params.push(size);
    conditions.push(`lower(regexp_replace(trim(p.unit), '\\s+', '', 'g')) = lower(regexp_replace(trim($${params.length}), '\\s+', '', 'g'))`);
  }
  const where = `WHERE ${conditions.join(" AND ") || "TRUE"}`;
  const today = yerevanToday();
  params.push(today);
  const todayParamIndex = params.length;
  // This is just a stable pre-sort -- the client applies the real
  // brand/family/viscosity/size order (client/public/js/productSort.js,
  // shared with Pricelist, Order creation, and the Product Catalog admin
  // screen) on the response. A numeric cast on `unit` was tried here
  // previously and crashed the whole request for any non-liter unit
  // (e.g. "pc", "set") that doesn't end in a number+"L" -- avoided by
  // just ordering on the raw text.
  const { rows } = await pool.query(
    `WITH sel AS (SELECT p.id FROM products p ${where}),
     ${stockFigureCtes("sel")},
     demand AS (
       SELECT product_id,
              SUM(qty) FILTER (WHERE order_date >= $${todayParamIndex}::date - 30) AS qty_30d,
              SUM(qty) FILTER (WHERE order_date >= $${todayParamIndex}::date - 90) AS qty_90d,
              MAX(order_date) AS last_sale_date
       FROM erp_order_lines
       WHERE product_id IS NOT NULL
       GROUP BY product_id
     )
     SELECT p.id, p.erp_product_id, p.name, p.brand, p.family, p.unit, p.stock_qty, p.bronze_price_amd, p.silver_price_amd,
            COALESCE(NULLIF(p.silver_price_amd, 0), NULLIF(p.bronze_price_amd, 0)) AS wholesale_price_amd,
            p.landing_cost_amd, p.net_cost_amd, p.created_at,
            ${STOCK_FIGURE_COLUMNS},
            d.qty_30d, d.qty_90d, d.last_sale_date
     FROM products p
     ${STOCK_FIGURE_JOINS}
     LEFT JOIN demand d ON d.product_id = p.erp_product_id
     ${where}
     ORDER BY p.brand NULLS LAST, p.family NULLS LAST, p.name`,
    params
  );

  // stock_status filter runs after the forecast is computed (it depends on
  // the same model the badge shows, not a cheap SQL predicate) -- the WM's
  // 3-way choice collapses the model's finer 'critical'/'low' split into
  // one "low stock" bucket, and everything else that isn't out-of-stock
  // into "on stock" (a dead/new/slow/unknown row still physically has
  // stock sitting on the shelf, just nothing to size a days-left number on).
  const STOCK_FILTER_BUCKETS = {
    out_of_stock: (status) => status === "out",
    low_stock: (status) => status === "critical" || status === "low",
    on_stock: (status) => status !== "out" && status !== "critical" && status !== "low",
  };
  const bucketMatches = STOCK_FILTER_BUCKETS[stock];

  const annotated = [];
  // the company's demand model (products/demandModel.js; the method is on the Products and Documents pages): weighted weekly sales,
  // outliers damped, lumpy sales by Croston, safety stock and reorder point, stock already promised to open orders left out
  // Owner, 2026-11-23: the list shows FREE stock (appStock.js freeStockSql: what can still be sold), the Excel number beside it. The days-left
  // model starts from the same free stock and, being planning, also leaves out what submitted orders already want.
  const [{ weekly }, demandSettings] = await Promise.all([loadDemandInputs(pool, today), getDemandSettings(pool)]);
  for (const row of rows) {
    row.available_qty = row.stock_qty == null ? null : Number(row.stock_qty) - row.held_qty + row.back_on_shelf_qty;
    const forecast = computeDemandForecast({
      leadTimeDays: demandSettings.leadTimeDays,
      serviceZ: demandSettings.serviceZ, reviewDays: demandSettings.coverDays,
      weeklyQty: weekly.get(row.erp_product_id) ?? [],
      stockQty: row.available_qty,
      reservedQty: row.submitted_qty,
      lastSaleDate: row.last_sale_date,
      createdAt: row.created_at,
      today,
    });
    if (bucketMatches && !bucketMatches(forecast.status)) continue;
    const { qty_30d, qty_90d, last_sale_date, erp_product_id, back_on_shelf_qty, ...rest } = row;
    // Net cost per pack at the wholesale price (the workbook's own number is off for packs over 1 L): discountPolicy.js
    if (rest.net_cost_amd != null) rest.net_cost_amd = Math.round(displayNetCost({ ...rest, unit_price_amd: rest.bronze_price_amd }));
    annotated.push({
      ...rest,
      stock_status: forecast.status,
      daily_demand: forecast.dailyDemand,
      days_of_stock: forecast.daysOfStock,
      demand_trend: forecast.trend,
      free_stock: forecast.freeStock,
      reorder_point: forecast.reorderPoint,
      safety_stock: forecast.safetyStock,
      days_to_reorder: forecast.daysToReorder,
      demand_method: forecast.method,
      demand_variability: forecast.variability,
    });
  }
  // Capped after filtering, not before -- filtering by stock status on a
  // SQL-side LIMIT would silently drop rows a WM is specifically asking to
  // see. The catalog here is in the hundreds of SKUs, not tens of
  // thousands, so computing the forecast for every active row first is
  // cheap; 500 is just a sane upper bound on response size.
  res.json(annotated.slice(0, 500));
});

// "To order" list for the owner/warehouse: products that are out or running low,
// with how many pieces to buy to cover lead time + review days + safety stock again (stockForecast.js computeReorderSuggestion).
warehouseRouter.get("/reorder-suggestions", async (req, res) => {
  const today = yerevanToday();
  const { rows } = await pool.query(
    `WITH sel AS (SELECT p.id FROM products p WHERE p.active),
     ${stockFigureCtes("sel")},
     demand AS (
       SELECT product_id,
              SUM(qty) FILTER (WHERE order_date >= $1::date - 30) AS qty_30d,
              SUM(qty) FILTER (WHERE order_date >= $1::date - 90) AS qty_90d,
              MAX(order_date) AS last_sale_date
       FROM erp_order_lines WHERE product_id IS NOT NULL GROUP BY product_id
     )
     SELECT p.id, p.erp_product_id, p.name, p.brand, p.family, p.unit, p.size_l, p.items_per_pack, p.stock_qty, p.created_at, d.qty_30d, d.qty_90d, d.last_sale_date,
            ${STOCK_FIGURE_COLUMNS}
     FROM products p ${STOCK_FIGURE_JOINS} LEFT JOIN demand d ON d.product_id = p.erp_product_id
     WHERE p.active`,
    [today]
  );
  const out = [];
  const [demand, demandSettings, incoming] = await Promise.all([loadDemandInputs(pool, today), getDemandSettings(pool), incomingLotsByProduct()]);
  for (const row of rows) {
    // pieces already Ordered / On the way (Purchases P5, owner 2026-11-20): what is coming is not suggested again
    const lots = incoming.get(row.id) ?? [];
    const coming = lots.reduce((a, l) => a + l.qty, 0);
    // free stock (appStock.js: Excel − held + back on the shelf) + what is ordered / on the way; submitted orders wanted on top (planning)
    const free = (Number(row.stock_qty) || 0) - row.held_qty + row.back_on_shelf_qty;
    const stockWithComing = free + coming;
    const forecast = computeDemandForecast({ leadTimeDays: demandSettings.leadTimeDays, serviceZ: demandSettings.serviceZ, reviewDays: demandSettings.coverDays, weeklyQty: demand.weekly.get(row.erp_product_id) ?? [], stockQty: stockWithComing, reservedQty: row.submitted_qty, lastSaleDate: row.last_sale_date, createdAt: row.created_at, today });
    // out / critical / low only; how much: the purchase suggestions' own calculation (shared/purchaseSuggestion.js purchaseLine: what must
    // last the cover days after the arrival, the goods on the way joining the shelf on their expected day, empty days lost)
    if (!["out", "critical", "low"].includes(forecast.status)) continue;
    const daily = forecast.dailyDemand ?? (Number(row.qty_90d) || 0) / 90;
    if (!(daily > 0)) continue;
    const line = purchaseLine({ stockNow: free, comingLots: lots, wanted: row.submitted_qty, daily, leadTimeDays: demandSettings.leadTimeDays, coverDays: demandSettings.coverDays, safetyStock: forecast.safetyStock ?? 0, stepPieces: packRule(row).stepPieces, trend: forecast.trend });
    if (!(line.need > 0)) continue;
    const suggestion = { urgency: forecast.status, suggested_qty: line.need, daily_demand: daily, days_of_stock: forecast.daysOfStock };
    // what is really bought: whole steps of packs, rounded the way the smart suggestions round (one step less when it still covers the cover
    // days or sales are falling; owner 2026-11-26), so To order and Smart suggestions agree; the pure need stays as need_qty
    const packs = roundToPacks(line.suggested, row);
    out.push({ id: row.id, name: row.name, brand: row.brand, family: row.family, unit: row.unit, stock_qty: row.stock_qty, free_qty: free, reserved_qty: row.held_qty + row.submitted_qty, submitted_qty: row.submitted_qty, incoming_qty: coming, demand_trend: forecast.trend, ...suggestion, need_qty: suggestion.suggested_qty, suggested_qty: packs.pieces, packs: packs.packs, pack_size: packs.packSize, pack_kind: packs.kind });
  }
  const rank = { out: 0, critical: 1, low: 2 };
  out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.days_of_stock ?? 0) - (b.days_of_stock ?? 0));
  res.json(out.slice(0, 300));
});

// Distinct brand/size lists for the inventory screen's filter sheet -- kept
// separate from the paginated/searched inventory rows themselves so the
// filter's own option lists don't shrink as a search narrows the results.
warehouseRouter.get("/inventory/brands", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT DISTINCT brand FROM products WHERE active AND brand IS NOT NULL ORDER BY brand"
  );
  res.json(rows.map((r) => r.brand));
});

warehouseRouter.get("/inventory/sizes", async (req, res) => {
  // One representative raw spelling per normalized size (see the `size`
  // filter above) -- otherwise "1l" and "1L" on different products would
  // list as two options that both display as "1 L" in the sheet, with no
  // way to tell them apart.
  const { rows } = await pool.query(
    `SELECT (array_agg(unit ORDER BY unit))[1] AS unit
     FROM products
     WHERE active AND unit IS NOT NULL
     GROUP BY lower(regexp_replace(trim(unit), '\\s+', '', 'g'))`
  );
  res.json(rows.map((r) => r.unit));
});

async function markPacked(orderId, changedBy) {
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { error: "Order not found", status: 404 };
  if (order.status !== "confirmed") {
    return { error: `Cannot mark "${order.status}" as packed -- only a confirmed order can be packed`, status: 409 };
  }

  // The status check above is only a pre-check -- the bulk-packed endpoint
  // below can process the same order twice in the same request via a
  // duplicated id, and two warehouse staff can double-tap the same order
  // in the UI at once. This guarded UPDATE is the actual lock: only the
  // first to reach it flips the status; the second gets nothing back and
  // is treated as already-packed rather than silently re-packing it.
  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'packed_stock_out', updated_at = now() WHERE id = $1 AND status = 'confirmed' RETURNING *",
    [order.id]
  );
  if (!updatedRows[0]) {
    return { error: `Cannot mark "${order.status}" as packed -- only a confirmed order can be packed`, status: 409 };
  }
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'confirmed', 'packed_stock_out', 'Packed', $2)`,
    [order.id, changedBy]
  );

  (async () => {
    try {
      // Packed orders are picked up by the route planner, not pushed to one
      // driver directly -- notify delivery_manager/admin generally so
      // whoever plans routes knows there's fresh stock ready to route.
      const { rows: deliveryRows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
      for (const d of deliveryRows) {
        notifyUser(d.id, "order_packed", {
          title: "Պատվերը փաթեթավորվեց",
          body: `${order.customer_name}-ի պատվերը փաթեթավորված է և պատրաստ երթուղավորման։`,
          url: "/#/delivery",
        });
      }
    } catch (err) {
      console.error("Post-packed notification failed:", err);
    }
  })();

  return { order: updatedRows[0] };
}

warehouseRouter.post("/orders/:id/packed", async (req, res) => {
  const result = await markPacked(req.params.id, req.user.id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.order);
});

// C7: bulk mark-packed -- a WM staging a full batch shouldn't have to tap
// "Mark Packed" once per order. Best-effort per order (one bad id doesn't
// block the rest); the response lists which succeeded and which didn't.
warehouseRouter.post("/orders/bulk-packed", async (req, res) => {
  const { order_ids } = req.body ?? {};
  if (!Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({ error: "order_ids is required" });
  }
  const packed = [];
  const failed = [];
  for (const id of order_ids) {
    const result = await markPacked(id, req.user.id);
    if (result.error) failed.push({ id, error: result.error });
    else packed.push(result.order);
  }
  res.json({ packed, failed });
});

warehouseRouter.post("/orders/:id/stock-issue", async (req, res) => {
  const { note } = req.body ?? {};
  if (!note || !note.trim()) return res.status(400).json({ error: "A note is required to flag a stock issue" });

  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "confirmed") {
    return res.status(409).json({ error: `Cannot flag a stock issue on "${order.status}" -- only a confirmed order qualifies` });
  }

  // Guarded the same way as markPacked() above -- a race against a
  // concurrent "mark packed" tap on the same order shouldn't be able to
  // flag a stock issue on an order that already moved on.
  const { rows: updatedRows } = await pool.query(
    // a document request still waiting for Lily is withdrawn with it (she must not make a waybill for an order sent back)
    `UPDATE orders SET status = 'draft', draft_reason = $1, updated_at = now(), ${WITHDRAW_WAITING_REQUEST_SQL} WHERE id = $2 AND status = 'confirmed' RETURNING *`,
    [note.trim(), order.id]
  );
  if (!updatedRows[0]) {
    return res.status(409).json({ error: `Cannot flag a stock issue on "${order.status}" -- only a confirmed order qualifies` });
  }
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'confirmed', 'draft', $2, $3)`,
    [order.id, note.trim(), req.user.id]
  );
  res.json(updatedRows[0]);
  // the accountants' group was told this order is confirmed: now it is told not to issue it yet (orders/orderGroupPost.js)
  syncOrderPostSoon(order.id, { byId: req.user.id, reason: note.trim() });

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [STOCK_ISSUE_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "order_stock_issue", {
          title: "Հայտնվել է պաշարի խնդիր",
          body: `${order.customer_name}-ի պատվեր. ${note.trim()}`,
          url: `/#/orders?open=${order.id}`,
        });
      }
    } catch (err) {
      console.error("Post-stock-issue notification failed:", err);
    }
  })();
});
