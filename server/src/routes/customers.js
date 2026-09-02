import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { seesAllActivity, canReassignCustomers, canDeleteOrEditDirectly, canAssignErpCustomerId } from "../roles.js";
import { getDefaultVisitFrequencyDays } from "../settings.js";

export const customersRouter = Router();

customersRouter.use(requireAuth);

const LAST_VISIT_SUBQUERY = `(SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id)`;

// Derived visit status — no assignment/planning data exists yet, so
// "overdue" is approximated from each customer's own visit_frequency_days
// against their actual last check-in, not a fabricated schedule.
const STATUS_COLUMNS = `
  ${LAST_VISIT_SUBQUERY} AS last_visit_at,
  EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now())) AS visited_today,
  EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days') AS visited_this_week,
  (
    NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now()))
    AND (
      ${LAST_VISIT_SUBQUERY} IS NULL
      OR ${LAST_VISIT_SUBQUERY} < now() - (c.visit_frequency_days || ' days')::interval
    )
  ) AS overdue
`;

customersRouter.get("/", async (req, res) => {
  const { search, visited, region, subregion, assigned_manager_id } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`c.name ILIKE $${params.length}`);
  }
  if (region) {
    params.push(region);
    conditions.push(`c.region = $${params.length}`);
  }
  if (subregion) {
    params.push(subregion);
    conditions.push(`c.subregion = $${params.length}`);
  }
  if (assigned_manager_id) {
    params.push(assigned_manager_id);
    conditions.push(`c.assigned_manager_id = $${params.length}`);
  }
  if (visited === "visited") {
    conditions.push(`EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days')`);
  } else if (visited === "not_visited") {
    conditions.push(`NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days')`);
  } else if (visited === "overdue") {
    conditions.push(`(
      NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now()))
      AND (
        ${LAST_VISIT_SUBQUERY} IS NULL
        OR ${LAST_VISIT_SUBQUERY} < now() - (c.visit_frequency_days || ' days')::interval
      )
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT c.*, ${STATUS_COLUMNS}
     FROM customers c
     ${where}
     ORDER BY c.name`,
    params
  );
  res.json(rows);
});

const CUSTOMER_TIERS = new Set(["potential", "bronze", "silver", "gold", "competitor"]);

// A generous bounding box around Armenia (not a precise border polygon --
// this only needs to catch "the pin landed in the wrong country," e.g. a
// slipped tap on the map or a stale GPS fix from a phone that was abroad
// last, not to be a strict customs-grade boundary).
const ARMENIA_BOUNDS = { minLat: 38.8, maxLat: 41.35, minLng: 43.4, maxLng: 46.65 };

function isWithinArmenia(lat, lng) {
  return (
    lat >= ARMENIA_BOUNDS.minLat &&
    lat <= ARMENIA_BOUNDS.maxLat &&
    lng >= ARMENIA_BOUNDS.minLng &&
    lng <= ARMENIA_BOUNDS.maxLng
  );
}

customersRouter.post("/", async (req, res) => {
  const {
    name,
    category,
    phone,
    address,
    notes,
    lat,
    lng,
    visit_frequency_days,
    erp_customer_id,
    tin,
    region,
    subregion,
    customer_tier,
    sales_channel,
  } = req.body ?? {};

  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "name, lat and lng are required" });
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must be numbers" });
  }
  if (!isWithinArmenia(lat, lng)) {
    return res.status(400).json({ error: "This location is outside Armenia. Double-check the pin placement." });
  }
  if (customer_tier !== undefined && !CUSTOMER_TIERS.has(customer_tier)) {
    return res.status(400).json({ error: "Invalid customer_tier" });
  }

  const { rows } = await pool.query(
    `INSERT INTO customers (name, category, phone, address, notes, lat, lng, created_by, assigned_manager_id, visit_frequency_days, erp_customer_id, tin, region, subregion, customer_tier, sales_channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, COALESCE($14, 'potential'), $15)
     RETURNING *`,
    [
      name,
      category ?? null,
      phone ?? null,
      address ?? null,
      notes ?? null,
      lat,
      lng,
      req.user.id,
      Number(visit_frequency_days) || (await getDefaultVisitFrequencyDays()),
      erp_customer_id || null,
      tin || null,
      region || null,
      subregion || null,
      customer_tier || null,
      sales_channel || null,
    ]
  );
  res.status(201).json(rows[0]);
});

// Distinct region/subregion values already in use, for the Customers page
// filter dropdowns -- avoids hardcoding a region list that would drift from
// what's actually been entered or synced from the ERP file.
customersRouter.get("/regions", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT region, subregion FROM customers WHERE region IS NOT NULL ORDER BY region, subregion`
  );
  res.json(rows);
});

// Latest recorded brand-availability tags per customer (from checkins'
// assortment-check brand grid), for the map's "Brands" filter -- e.g. so a
// director can see how Mobil is actually distributed across Yerevan, not
// just our own brands. DISTINCT ON picks each customer's single most
// recent checkin that actually recorded brand data; a customer never
// checked this way just doesn't appear.
customersRouter.get("/brand-status", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (customer_id) customer_id, brand_status, timestamp
     FROM checkins
     WHERE brand_status IS NOT NULL
     ORDER BY customer_id, timestamp DESC`
  );
  res.json(rows);
});

customersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, ${STATUS_COLUMNS},
       am.name AS assigned_manager_name,
       erp.assigned_sales_rep AS erp_assigned_sales_rep,
       erp.debt_amd AS erp_debt_amd,
       erp.last_payment_date AS erp_last_payment_date,
       erp.days_since_payment AS erp_days_since_payment,
       erp.aging_bucket AS erp_aging_bucket,
       erp.recent_orders AS erp_recent_orders,
       erp.synced_at AS erp_synced_at,
       (SELECT COALESCE(SUM(ch.amount_collected_amd), 0)
          FROM checkins ch
          WHERE ch.customer_id = c.id
            AND ch.amount_collected_amd IS NOT NULL
            AND (erp.synced_at IS NULL OR ch.timestamp > erp.synced_at)
       ) AS collected_since_sync_amd
     FROM customers c
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  const customer = rows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  // Estimated, not authoritative: the real debt figure only ever comes from
  // the next ERP sync. This just reflects payments the app already knows
  // about that the last sync predates, so the number on screen isn't stale
  // between syncs.
  if (customer.erp_debt_amd != null) {
    customer.estimated_debt_amd = Math.max(0, Number(customer.erp_debt_amd) - Number(customer.collected_since_sync_amd));
  }
  res.json(customer);
});

export const EDITABLE_FIELDS = [
  "name",
  "category",
  "phone",
  "address",
  "notes",
  "lat",
  "lng",
  "visit_frequency_days",
  "erp_customer_id",
  "tin",
  "region",
  "subregion",
  "customer_tier",
  "assigned_manager_id",
  "sales_channel",
];

// A director/ceo (not just admin) can fix these four directly -- everything
// else on EDITABLE_FIELDS still needs canDeleteOrEditDirectly (admin), same
// as before, or goes through the edit-request approval flow.
const REASSIGNMENT_FIELDS = new Set(["region", "subregion", "assigned_manager_id", "sales_channel"]);

customersRouter.patch("/:id", async (req, res) => {
  const fieldsPresent = EDITABLE_FIELDS.filter((f) => req.body?.[f] !== undefined);
  const onlyErpField = fieldsPresent.length === 1 && fieldsPresent[0] === "erp_customer_id";

  if (onlyErpField) {
    // Linking to ERP has its own ownership-based rule (see
    // canAssignErpCustomerId) instead of the blanket admin-or-request-review
    // rule below -- it's a lookup/link action, not a factual change.
    const { rows: ownerRows } = await pool.query("SELECT created_by FROM customers WHERE id = $1", [req.params.id]);
    if (!ownerRows[0]) return res.status(404).json({ error: "Customer not found" });
    if (!canAssignErpCustomerId(req.user.role, ownerRows[0].created_by, req.user.id)) {
      return res.status(403).json({ error: "Not allowed to link this customer to an ERP record" });
    }
  } else {
    const onlyReassignmentFields = fieldsPresent.length > 0 && fieldsPresent.every((f) => REASSIGNMENT_FIELDS.has(f));
    const allowed = onlyReassignmentFields ? canReassignCustomers(req.user.role) : canDeleteOrEditDirectly(req.user.role);
    if (!allowed) {
      return res.status(403).json({ error: "Only admins can apply this directly" });
    }
  }

  if (req.body?.customer_tier !== undefined && !CUSTOMER_TIERS.has(req.body.customer_tier)) {
    return res.status(400).json({ error: "Invalid customer_tier" });
  }
  if (req.body?.lat !== undefined || req.body?.lng !== undefined) {
    const nextLat = req.body.lat;
    const nextLng = req.body.lng;
    if (typeof nextLat !== "number" || typeof nextLng !== "number" || !isWithinArmenia(nextLat, nextLng)) {
      return res.status(400).json({ error: "This location is outside Armenia. Double-check the pin placement." });
    }
  }

  const updates = [];
  const params = [];

  for (const field of EDITABLE_FIELDS) {
    if (req.body?.[field] !== undefined) {
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
  }
  if (!updates.length) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  res.json(rows[0]);
});

customersRouter.delete("/:id", requireAdmin, async (req, res) => {
  const customerId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // visit_plans/visit_plan_rules reference customers via a plain integer
    // array (customer_ids), which Postgres can't foreign-key -- without this,
    // a deleted customer's id lingers forever as an unnamed ghost stop on
    // whichever rep's plan/rule it was on.
    await client.query(
      "UPDATE visit_plans SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)",
      [customerId]
    );
    await client.query(
      "UPDATE visit_plan_rules SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)",
      [customerId]
    );
    const { rowCount } = await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Customer not found" });
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Order-level list for a customer's ERP order history: individual line
// items grouped into real orders by order_id/order_date, with a summed
// total per order. scope=recent (default) is the last 3 months for the
// inline preview on the customer detail page; scope=all removes that
// filter for the "show all orders" screen.
customersRouter.get("/:id/erp-orders", async (req, res) => {
  const scope = req.query.scope === "all" ? "all" : "recent";
  const { rows: customerRows } = await pool.query("SELECT erp_customer_id FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  const erpCustomerId = customerRows[0]?.erp_customer_id;
  if (!erpCustomerId) return res.json([]);

  const dateFilter = scope === "recent" ? "AND order_date >= now() - interval '3 months'" : "";
  const { rows } = await pool.query(
    `SELECT order_id, order_date, sum(revenue_amd) AS total_amd
     FROM erp_order_lines
     WHERE erp_customer_id = $1 ${dateFilter}
     GROUP BY order_id, order_date
     ORDER BY order_date DESC, order_id DESC
     LIMIT 200`,
    [erpCustomerId]
  );
  res.json(rows);
});

// Line-item detail for one order (product/brand/qty/price), for the
// click-into-an-order view. Grouped by brand client-side.
customersRouter.get("/:id/erp-orders/:orderId", async (req, res) => {
  const { rows: customerRows } = await pool.query("SELECT erp_customer_id FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  const erpCustomerId = customerRows[0]?.erp_customer_id;
  if (!erpCustomerId) return res.status(404).json({ error: "Customer not linked to an ERP record" });

  const { rows } = await pool.query(
    `SELECT order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd
     FROM erp_order_lines
     WHERE erp_customer_id = $1 AND order_id = $2
     ORDER BY brand, product_name`,
    [erpCustomerId, req.params.orderId]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found" });
  res.json({
    order_id: rows[0].order_id,
    order_date: rows[0].order_date,
    total_amd: rows.reduce((sum, r) => sum + Number(r.revenue_amd || 0), 0),
    lines: rows,
  });
});

// Distinct products this customer has ever ordered -- from this app's own
// orders (order_items) and, if linked, the full ERP order history
// (erp_order_lines) -- for the "product availability check" picker at
// check-in, so a rep only has to tick which of what this shop actually
// carries is currently in stock, not browse the whole catalog.
customersRouter.get("/:id/ordered-products", async (req, res) => {
  const { rows: customerRows } = await pool.query("SELECT erp_customer_id FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const { rows } = await pool.query(
    `SELECT DISTINCT brand, product_name FROM (
       SELECT p.brand AS brand, oi.product_name AS product_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.customer_id = $1

       UNION ALL

       SELECT brand, product_name
       FROM erp_order_lines
       WHERE erp_customer_id = $2
     ) combined
     WHERE product_name IS NOT NULL
     ORDER BY brand, product_name`,
    [req.params.id, customer.erp_customer_id]
  );
  res.json(rows);
});

// Upcoming approved plan dates this customer is on -- for the map pin
// popup ("planned visit dates"). Small, so no pagination.
customersRouter.get("/:id/planned-visits", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT vp.plan_date, vp.user_id, u.name AS user_name
     FROM visit_plans vp
     JOIN users u ON u.id = vp.user_id
     WHERE $1 = ANY(vp.customer_ids) AND vp.status = 'approved' AND vp.plan_date >= CURRENT_DATE
     ORDER BY vp.plan_date
     LIMIT 5`,
    [req.params.id]
  );
  res.json(rows);
});

customersRouter.get("/:id/checkins", async (req, res) => {
  // Plain managers only see their own visit history on a customer, same
  // restriction as GET /api/checkins.
  const params = [req.params.id];
  let userFilter = "";
  if (!seesAllActivity(req.user.role)) {
    params.push(req.user.id);
    userFilter = `AND ch.user_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name,
       COALESCE(
         (SELECT json_agg(json_build_object('id', cp.id) ORDER BY cp.id) FROM checkin_photos cp WHERE cp.checkin_id = ch.id),
         '[]'
       ) AS photos
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     WHERE ch.customer_id = $1 ${userFilter}
     ORDER BY ch.timestamp DESC`,
    params
  );
  res.json(rows);
});
