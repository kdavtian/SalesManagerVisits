import { Router } from "express";
import { pool } from "../db/pool.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { seesAllActivity, canReassignCustomers, canDeleteOrEditDirectly, canAssignErpCustomerId, canEditOwnSalesChannel, seesFinancialExports, seesCustomerErpData, canSetCreditTerms } from "../roles.js";
import { creditSnapshot } from "../creditLimit.js";
import { visitPriorities } from "../visitPriorities.js";
import { getDefaultVisitFrequencyDays } from "../settings.js";
import { haversineMeters } from "../utils/geo.js";
import { lookupCompanyByTin, isValidTin } from "../registryLookup.js";
import { computeVisitDue, ruleWeekdaysFor } from "../utils/visitDue.js";

export const customersRouter = Router();

customersRouter.use(requireAuth);

// KF/CAS/CVO/PCO/OEM are channels Castrol serves through a route that
// doesn't involve field visits (key accounts / distributor-managed / OEM
// contracts), so these customers never need to show up as "overdue" or
// "not visited" no matter how long since their last check-in.
export const NO_VISIT_CHANNELS = ["KF", "CAS", "CVO", "PCO", "OEM"];
export const NOT_NO_VISIT_CHANNEL_SQL = `COALESCE(c.sales_channel, '') <> ALL(ARRAY[${NO_VISIT_CHANNELS.map((v) => `'${v}'`).join(",")}])`;

// Derived visit status — no assignment/planning data exists yet, so
// "overdue" is approximated from each customer's own visit_frequency_days
// against their actual last check-in, not a fabricated schedule.
//
// The per-customer check-in facts come from ONE lateral aggregate (alias v)
// instead of six correlated subqueries: PostgreSQL planned each
// `max(timestamp)` subquery as a walk down the global timestamp index,
// skipping every other customer's rows, so the list took ~1 s per 3,000
// customers (and grew with the check-in history). Joined once per customer
// through the customer_id index it is a few ms.
const VISIT_STATUS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT max(ch.timestamp) AS last_visit_at,
           COALESCE(bool_or(ch.timestamp >= date_trunc('day', now())), false) AS visited_today,
           COALESCE(bool_or(ch.timestamp >= now() - interval '7 days'), false) AS visited_this_week
    FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range
  ) v ON true`;
const OVERDUE_SQL = `(
    ${NOT_NO_VISIT_CHANNEL_SQL}
    AND NOT v.visited_today
    AND (v.last_visit_at IS NULL OR v.last_visit_at < now() - (c.visit_frequency_days || ' days')::interval)
  )`;
const STATUS_COLUMNS = `
  v.last_visit_at AS last_visit_at,
  v.visited_today AS visited_today,
  v.visited_this_week AS visited_this_week,
  ${OVERDUE_SQL} AS overdue,
  -- Whether this customer is on a channel that is visited in the field at
  -- all. Exposed as its own flag (rather than the client re-deriving it
  -- from sales_channel) so the exemption list lives in exactly one place;
  -- the Customers list uses it to suppress "Overdue"/"Not visited" labels
  -- for channels that are never supposed to carry them.
  ${NOT_NO_VISIT_CHANNEL_SQL} AS requires_visit
`;

// Plan-aware "overdue" (see utils/visitDue.js): replaces the plain
// last-visit + N days SQL approximation once the active Route Plans rules
// are known. No-visit channels and customers visited today are never overdue.
async function applyPlannedOverdue(rows) {
  const { rows: ruleRows } = await pool.query(`SELECT day_of_week, customer_ids, areas FROM visit_plan_rules WHERE active`);
  const rules = ruleRows.map((r) => ({ ...r, customer_id_set: new Set(r.customer_ids ?? []) }));
  const today = yerevanToday();
  for (const row of rows) {
    const due = computeVisitDue({
      lastVisitAt: row.last_visit_at,
      frequencyDays: row.visit_frequency_days,
      ruleWeekdays: ruleWeekdaysFor(row, rules),
      today,
    });
    row.overdue = Boolean(row.requires_visit) && !row.visited_today && due.overdue;
  }
}

customersRouter.get("/", async (req, res) => {
  const { search, visited, region, subregion, include_debt, min_lat, max_lat, min_lng, max_lng } = req.query;
  // A sales_manager's own book only -- always, not just when the client
  // happens to pass this filter. Every other route scoping a plain
  // manager to their own data (orders.js's GET /, checkins.js, this same
  // file's GET /:id/checkins) already does this the same way; this list
  // endpoint was the one gap left wide open, returning every customer in
  // the company to any authenticated role with no filter at all.
  const assigned_manager_id = seesAllActivity(req.user.role) ? req.query.assigned_manager_id : req.user.id;
  const conditions = [];
  const params = [];

  // Optional viewport/region payload limit (improvement list 7.4) -- not
  // used by the map's own default fetch yet (that still needs the full
  // list for its filters, route planning, and "nearby" search, all of
  // which read from the complete customer set), but available for any
  // consumer that only cares about what's on screen right now, e.g. a
  // future paginated/viewport-only map mode.
  if (min_lat && max_lat) {
    params.push(min_lat, max_lat);
    conditions.push(`c.lat BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (min_lng && max_lng) {
    params.push(min_lng, max_lng);
    conditions.push(`c.lng BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (search) {
    // Every word must match name, ERP id, TIN, address, region/district,
    // social profiles, email or website; phone matches on digits only so
    // "091 101370" finds "+37491101370".
    for (const word of String(search).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      params.push(`%${word.replace(/^@/, "")}%`);
      const likeIdx = params.length;
      const digits = word.replace(/\D/g, "").replace(/^374/, "").replace(/^0+/, "");
      let phoneClause = "";
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        phoneClause = ` OR regexp_replace(c.phone, '\\D', '', 'g') LIKE $${params.length}`;
      }
      conditions.push(
        `(c.name ILIKE $${likeIdx} OR c.erp_customer_id ILIKE $${likeIdx} OR c.tin ILIKE $${likeIdx} OR c.legal_name ILIKE $${likeIdx} OR c.address ILIKE $${likeIdx} OR c.region ILIKE $${likeIdx} OR c.subregion ILIKE $${likeIdx} OR c.instagram_username ILIKE $${likeIdx} OR c.facebook_url ILIKE $${likeIdx} OR c.email ILIKE $${likeIdx} OR c.website ILIKE $${likeIdx}${phoneClause})`
      );
    }
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
    conditions.push(`v.visited_this_week`);
  } else if (visited === "not_visited") {
    conditions.push(`${NOT_NO_VISIT_CHANNEL_SQL} AND NOT v.visited_this_week`);
  } else if (visited === "overdue") {
    conditions.push(OVERDUE_SQL);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Outstanding debt is opt-in (see task spec: "off by default, to make
  // app run faster") -- the LEFT JOIN and its per-row lookup only happen
  // when the Customers list toggle actually asks for it.
  const debtJoin = include_debt ? "LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id" : "";
  const debtColumn = include_debt ? "erp.debt_amd AS debt_amd," : "";
  const { rows } = await pool.query(
    `SELECT c.*, ${debtColumn} am.name AS assigned_manager_name, ${STATUS_COLUMNS}
     FROM customers c
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     ${VISIT_STATUS_JOIN}
     ${debtJoin}
     ${where}
     ORDER BY c.name`,
    params
  );
  // debt_amd is ERP commercial data -- a sales_manager only sees it for
  // customers assigned to them (see seesCustomerErpData); everyone else's
  // rows still come back, just without that one field.
  if (include_debt && req.user.role === "sales_manager") {
    for (const row of rows) {
      if (!seesCustomerErpData(req.user.role, row.assigned_manager_id, req.user.id)) row.debt_amd = null;
    }
  }
  await applyPlannedOverdue(rows);
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

// Two different app customer records linking to the same real-world ERP
// customer (a plausible data-entry mistake -- e.g. the same shop visited
// and separately entered by two reps, each later linking their own record
// to the same ERP ID) used to be silently allowed, with nothing enforcing
// erp_customer_id was actually unique. debtBalances.js's own
// JOIN customers c ON c.erp_customer_id = ecd.erp_customer_id would then
// match more than one customer per ERP debt record, each potentially
// carrying a different (or missing) assigned_manager_id -- reported as
// "missing/incorrect assignment data in debt balances". Checked before
// every create/link below, on top of the DB-level uniqueness constraint
// itself (migration 069) that's the actual backstop against a race.
async function findErpCustomerIdConflict(erpCustomerId, excludeId) {
  const params = [erpCustomerId];
  let where = "erp_customer_id = $1";
  if (excludeId) {
    params.push(excludeId);
    where += ` AND id != $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT id, name FROM customers WHERE ${where}`, params);
  if (!rows[0]) return null;
  return { error: `ERP customer ID "${erpCustomerId}" is already linked to another customer (${rows[0].name})` };
}

export function normalizeCustomerName(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// Same name within a tight radius is a near-certain sign the same physical
// shop got entered twice (two reps visiting the same place independently,
// or one rep re-adding a customer they couldn't find in search) rather
// than two different businesses that happen to share a name -- a real
// coincidence needs to be much farther apart than this to both be real.
// Deliberately NOT a DB-level constraint (unlike erp_customer_id): a name
// isn't a stable enough identity for a hard block, so this is a soft
// pre-check the caller can override with confirm_duplicate: true after
// being shown the match, not an unconditional 409 the way an ERP-id clash
// is.
export const DUPLICATE_CUSTOMER_RADIUS_METERS = 30;

async function findDuplicateCustomer(name, lat, lng, excludeId) {
  const normalized = normalizeCustomerName(name);
  // Bounding-box pre-filter in SQL (cheap, index-friendly-enough at this
  // scale) -- exact haversine distance is only computed in JS against the
  // handful of candidates it returns, not the whole table.
  const latDelta = DUPLICATE_CUSTOMER_RADIUS_METERS / 111000; // ~111km per degree of latitude
  const lngDelta = latDelta / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const params = [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta];
  let where = "lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4";
  if (excludeId) {
    params.push(excludeId);
    where += ` AND id != $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT id, name, lat, lng FROM customers WHERE ${where}`, params);
  for (const row of rows) {
    if (
      normalizeCustomerName(row.name) === normalized &&
      haversineMeters(lat, lng, row.lat, row.lng) <= DUPLICATE_CUSTOMER_RADIUS_METERS
    ) {
      return row;
    }
  }
  return null;
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
    assigned_manager_id,
    credit_term_days,
    payment_method,
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
  if (payment_method !== undefined && payment_method !== "cash" && payment_method !== "invoice") {
    return res.status(400).json({ error: "payment_method must be 'cash' or 'invoice'" });
  }
  if (credit_term_days !== undefined && !(Number.isInteger(Number(credit_term_days)) && Number(credit_term_days) > 0)) {
    return res.status(400).json({ error: "credit_term_days must be a positive whole number" });
  }
  if (erp_customer_id) {
    const conflict = await findErpCustomerIdConflict(erp_customer_id);
    if (conflict) return res.status(409).json(conflict);
  }
  if (!req.body?.confirm_duplicate) {
    const duplicate = await findDuplicateCustomer(name, lat, lng);
    if (duplicate) {
      // Same "duplicate_warning" + confirm_duplicate override shape
      // payments.js's own findLikelyDuplicate check already established --
      // one convention for "this looks like a repeat, are you sure" across
      // the app instead of a bespoke one per resource.
      return res.status(409).json({
        error: "duplicate_warning",
        message: `A customer named "${duplicate.name}" already exists within ${DUPLICATE_CUSTOMER_RADIUS_METERS}m of this location -- likely the same shop entered twice`,
        similar_customer: duplicate,
      });
    }
  }

  // Same ERP-ID-implies-at-least-Bronze rule as the PATCH handler below,
  // applied at creation time: a brand-new customer entered with an ERP ID
  // already in hand starts at Bronze instead of Potential, unless whoever
  // is creating it explicitly picked a tier themselves (manual selection
  // always wins -- see canAssignErpCustomerId's PATCH counterpart).
  const initialTier = customer_tier || (erp_customer_id ? "bronze" : "potential");

  // Defaults to whoever is creating the customer, same as before this field
  // existed. A caller allowed to reassign customers (e.g. the Routes
  // Distribution auto-suggested manager on the new-customer form) can point
  // it at someone else instead; anyone without that permission has the
  // field silently ignored rather than erroring, since submitting the
  // default suggestion back is the common case.
  const resolvedManagerId = assigned_manager_id && canReassignCustomers(req.user.role) ? assigned_manager_id : req.user.id;

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO customers (name, category, phone, address, notes, lat, lng, created_by, assigned_manager_id, visit_frequency_days, erp_customer_id, tin, region, subregion, customer_tier, sales_channel, credit_term_days, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $16, $9, $10, $11, $12, $13, $14, $15, $17, $18)
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
        initialTier,
        sales_channel || null,
        resolvedManagerId,
        Number(credit_term_days) || 45,
        payment_method || "invoice",
      ]
    ));
  } catch (err) {
    // The pre-check above closes the common case; this catches the rare
    // race of two requests linking the same erp_customer_id at once (see
    // customers_erp_customer_id_unique_idx, migration 069).
    if (err.code === "23505" && erp_customer_id) {
      const conflict = await findErpCustomerIdConflict(erp_customer_id);
      if (conflict) return res.status(409).json(conflict);
    }
    throw err;
  }
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

// Products-at-the-shop summary, built from what check-ins recorded in
// brand_status ({castrol|lotos|royal|competitors: [values]}). Two views per
// customer:
//   current -- for each brand group, the values from the MOST RECENT visit
//              that recorded that group. A visit that skips a group leaves
//              that group's earlier answer in place (chips only change when a
//              new visit records the group again).
//   ever    -- every value any visit ever recorded, with the latest date it
//              was recorded (powers the Customers search/filter: "which shops
//              ever had fake Castrol").
// A sales manager only gets their own assigned customers.
const BRAND_GROUPS = ["castrol", "lotos", "royal", "competitors"];
customersRouter.get("/brand-summary", async (req, res) => {
  const params = [BRAND_GROUPS];
  let join = "";
  let where = "";
  if (req.user.role === "sales_manager") {
    params.push(req.user.id);
    join = `JOIN customers c ON c.id = ch.customer_id AND c.assigned_manager_id = $${params.length}`;
  }
  const customerId = Number(req.query.customer_id);
  if (Number.isInteger(customerId) && customerId > 0) {
    params.push(customerId);
    where = `AND ch.customer_id = $${params.length}`;
  }
  const base = `
    FROM checkins ch
    ${join}
    CROSS JOIN unnest($1::text[]) AS g(grp)
    WHERE ch.brand_status IS NOT NULL
      AND jsonb_typeof(ch.brand_status -> g.grp) = 'array'
      AND jsonb_array_length(ch.brand_status -> g.grp) > 0
      ${where}`;
  const [{ rows: currentRows }, { rows: everRows }] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (ch.customer_id, g.grp) ch.customer_id, g.grp AS grp, ch.brand_status -> g.grp AS vals, ch.timestamp AS as_of
       ${base}
       ORDER BY ch.customer_id, g.grp, ch.timestamp DESC`,
      params
    ),
    pool.query(
      `SELECT ch.customer_id, g.grp AS grp, v.value AS value, max(ch.timestamp) AS last_at
       ${base.replace("CROSS JOIN unnest($1::text[]) AS g(grp)", "CROSS JOIN unnest($1::text[]) AS g(grp) CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(ch.brand_status -> g.grp) = 'array' THEN ch.brand_status -> g.grp ELSE '[]'::jsonb END) AS v(value)")}
       GROUP BY ch.customer_id, g.grp, v.value`,
      params
    ),
  ]);
  const byCustomer = new Map();
  const entry = (id) => {
    if (!byCustomer.has(id)) byCustomer.set(id, { customer_id: id, current: {}, ever: [] });
    return byCustomer.get(id);
  };
  for (const r of currentRows) entry(r.customer_id).current[r.grp] = { values: r.vals, as_of: r.as_of };
  for (const r of everRows) entry(r.customer_id).ever.push({ group: r.grp, value: r.value, last_at: r.last_at });
  res.json([...byCustomer.values()]);
});

// Map pins: the popup facts (last visit, debt, planned date) for many
// customers in ONE request so the Map can warm the popups of the pins on
// screen. Same shape per customer as GET /:id/map-facts; unknown ids are
// simply absent from the result.
const MAP_FACTS_BATCH_MAX = 60;
customersRouter.get("/map-facts", async (req, res) => {
  const ids = [...new Set(String(req.query.ids ?? "").split(",").map(Number).filter(Number.isInteger))].slice(0, MAP_FACTS_BATCH_MAX);
  if (!ids.length) return res.json({});
  const [ctx, { rows }] = await Promise.all([
    loadScheduleContext(req),
    pool.query(
      `SELECT c.id, c.region, c.subregion, c.visit_frequency_days, c.assigned_manager_id, erp.debt_amd,
              (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range) AS last_visit_at
       FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
       WHERE c.id = ANY($1)`,
      [ids]
    ),
  ]);
  const out = {};
  for (const row of rows) {
    const schedule = scheduleForCustomer(row, ctx);
    const sees = seesCustomerErpData(req.user.role, row.assigned_manager_id, req.user.id);
    out[row.id] = { ...schedule, last_visit_at: schedule.cadence.last_visit_at, erp_debt_amd: sees ? row.debt_amd : null };
  }
  res.json(out);
});

// Legal name + legal address from the state register, by TIN. Best-effort:
// { found: false, reason } means "enter it manually" (never an HTTP error).
// "Visit first": the caller's own customers ranked by debt / overdue visit / gone quiet (visitPriorities.js).
// Registered before "/:id" so it is not read as a customer id.
customersRouter.get("/visit-priorities", async (req, res) => {
  if (req.user.role !== "sales_manager") return res.json([]);
  res.json(await visitPriorities(req.user.id));
});

// Registered before "/:id" so "tin-lookup" isn't read as a customer id.
const tinLookupCache = new Map();
customersRouter.get("/tin-lookup", async (req, res) => {
  const tin = String(req.query.tin ?? "").trim();
  if (!isValidTin(tin)) return res.json({ found: false, reason: "invalid_tin" });
  const hit = tinLookupCache.get(tin);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return res.json(hit.data);
  const data = await lookupCompanyByTin(tin);
  if (data.found) tinLookupCache.set(tin, { at: Date.now(), data });
  res.json(data);
});

// Signed accounting documents (from Lily) of all this customer's orders.
customersRouter.get("/:id/documents", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.order_id, d.hc_doc_number, d.filename, d.size_bytes, d.created_at, o.order_code, o.accounting_doc_type
     FROM order_documents d JOIN orders o ON o.id = d.order_id
     WHERE o.customer_id = $1 ORDER BY d.created_at DESC`,
    [req.params.id]
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
       ) AS collected_since_sync_amd,
       -- Unbounded, unlike GET /:id/erp-orders?scope=recent (which windows
       -- to the last 3 months for the "Sales this month" tile's purposes)
       -- -- a customer whose last order is older than that window was
       -- showing "-" here even though they do have order history, just
       -- not within that window.
       (SELECT MAX(eol.order_date) FROM erp_order_lines eol WHERE eol.erp_customer_id = c.erp_customer_id) AS erp_last_order_date
     FROM customers c
     ${VISIT_STATUS_JOIN}
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

  // ERP commercial data (debt, payment/order history) is withheld from a
  // sales_manager for a customer that isn't theirs -- everything else on
  // the card (name, address, category, ...) still comes back.
  if (!seesCustomerErpData(req.user.role, customer.assigned_manager_id, req.user.id)) {
    customer.erp_assigned_sales_rep = null;
    customer.erp_debt_amd = null;
    customer.erp_last_payment_date = null;
    customer.erp_days_since_payment = null;
    customer.erp_aging_bucket = null;
    customer.erp_recent_orders = [];
    customer.erp_last_order_date = null;
    customer.collected_since_sync_amd = 0;
    customer.estimated_debt_amd = null;
  }

  await applyPlannedOverdue([customer]);
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
  "legal_name",
  "legal_address",
  "region",
  "subregion",
  "customer_tier",
  "assigned_manager_id",
  "sales_channel",
  "credit_term_days",
  "payment_method",
];

// A director/ceo (not just admin) can fix these four directly -- everything
// else on EDITABLE_FIELDS still needs canDeleteOrEditDirectly (admin), same
// as before, or goes through the edit-request approval flow.
const REASSIGNMENT_FIELDS = new Set(["region", "subregion", "assigned_manager_id", "sales_channel"]);

// credit_term_days/payment_method are collections/finance settings -- same
// visibility line as the financial CSV exports (director/admin/ceo/
// accountant), not the admin-only default every other EDITABLE_FIELDS entry
// falls back to. Mirrors the pre-v3 FINANCE_FIELDS/seesPaymentAging gate
// that migration 051 removed along with credit_term_days itself.
const FINANCE_FIELDS = new Set(["credit_term_days", "payment_method"]);

customersRouter.patch("/:id", async (req, res) => {
  const fieldsPresent = EDITABLE_FIELDS.filter((f) => req.body?.[f] !== undefined);
  const onlyErpField = fieldsPresent.length === 1 && fieldsPresent[0] === "erp_customer_id";
  const onlyChannelField = fieldsPresent.length === 1 && fieldsPresent[0] === "sales_channel";

  const { rows: currentRows } = await pool.query(
    "SELECT created_by, erp_customer_id, customer_tier, name, lat, lng FROM customers WHERE id = $1",
    [req.params.id]
  );
  const current = currentRows[0];
  if (!current) return res.status(404).json({ error: "Customer not found" });

  if (onlyErpField) {
    // Linking to ERP has its own ownership-based rule (see
    // canAssignErpCustomerId) instead of the blanket admin-or-request-review
    // rule below -- it's a lookup/link action, not a factual change.
    if (!canAssignErpCustomerId(req.user.role, current.created_by, req.user.id)) {
      return res.status(403).json({ error: "Not allowed to link this customer to an ERP record" });
    }
  } else if (onlyChannelField) {
    // Sales channel alone gets the same ownership-based carve-out as ERP
    // linking above, rather than the canReassignCustomers-only rule the rest
    // of REASSIGNMENT_FIELDS uses -- a sales_manager can fix their own
    // customer's channel without being handed region/subregion/manager
    // reassignment too. See canEditOwnSalesChannel.
    if (!canEditOwnSalesChannel(req.user.role, current.created_by, req.user.id)) {
      return res.status(403).json({ error: "Not allowed to change this customer's sales channel" });
    }
  } else {
    const onlyReassignmentFields = fieldsPresent.length > 0 && fieldsPresent.every((f) => REASSIGNMENT_FIELDS.has(f));
    const onlyFinanceFields = fieldsPresent.length > 0 && fieldsPresent.every((f) => FINANCE_FIELDS.has(f));
    const allowed = onlyReassignmentFields
      ? canReassignCustomers(req.user.role)
      : onlyFinanceFields
        ? seesFinancialExports(req.user.role)
        : canDeleteOrEditDirectly(req.user.role);
    if (!allowed) {
      return res.status(403).json({ error: "Only admins can apply this directly" });
    }
  }

  if (req.body?.customer_tier !== undefined && !CUSTOMER_TIERS.has(req.body.customer_tier)) {
    return res.status(400).json({ error: "Invalid customer_tier" });
  }
  if (
    req.body?.payment_method !== undefined &&
    req.body.payment_method !== "cash" &&
    req.body.payment_method !== "invoice"
  ) {
    return res.status(400).json({ error: "payment_method must be 'cash' or 'invoice'" });
  }
  if (
    req.body?.credit_term_days !== undefined &&
    !(Number.isInteger(Number(req.body.credit_term_days)) && Number(req.body.credit_term_days) > 0)
  ) {
    return res.status(400).json({ error: "credit_term_days must be a positive whole number" });
  }
  if (req.body?.lat !== undefined || req.body?.lng !== undefined) {
    const nextLat = req.body.lat;
    const nextLng = req.body.lng;
    if (typeof nextLat !== "number" || typeof nextLng !== "number" || !isWithinArmenia(nextLat, nextLng)) {
      return res.status(400).json({ error: "This location is outside Armenia. Double-check the pin placement." });
    }
  }

  // ERP-ID-implies-at-least-Bronze: a customer only ever gets *pulled up*
  // to Bronze the moment they're first linked to a real ERP record, and
  // only from Potential -- Silver/Gold (assigned by a human) are never
  // touched, and re-linking/changing an already-set ERP ID later doesn't
  // re-trigger this (see task spec: "do not repeatedly modify level when
  // ERP ID changes later"). A caller setting customer_tier explicitly in
  // the same request always wins over this automatic bump.
  const newErpId = req.body?.erp_customer_id;
  const isNewErpLink = newErpId && !current.erp_customer_id;
  const autoUpgradeToBronze = isNewErpLink && req.body?.customer_tier === undefined && current.customer_tier === "potential";

  if (newErpId && newErpId !== current.erp_customer_id) {
    const conflict = await findErpCustomerIdConflict(newErpId, req.params.id);
    if (conflict) return res.status(409).json(conflict);
  }

  // Only re-check for a duplicate when this edit actually moves the pin
  // and/or renames the customer -- an edit that touches neither can't
  // newly collide with anything.
  const nextName = req.body?.name !== undefined ? req.body.name : current.name;
  const nextLat = req.body?.lat !== undefined ? req.body.lat : current.lat;
  const nextLng = req.body?.lng !== undefined ? req.body.lng : current.lng;
  if ((req.body?.name !== undefined || req.body?.lat !== undefined || req.body?.lng !== undefined) && !req.body?.confirm_duplicate) {
    const duplicate = await findDuplicateCustomer(nextName, nextLat, nextLng, req.params.id);
    if (duplicate) {
      return res.status(409).json({
        error: "duplicate_warning",
        message: `A customer named "${duplicate.name}" already exists within ${DUPLICATE_CUSTOMER_RADIUS_METERS}m of this location -- likely the same shop entered twice`,
        similar_customer: duplicate,
      });
    }
  }

  const fieldsToApply = { ...req.body };
  if (autoUpgradeToBronze) fieldsToApply.customer_tier = "bronze";

  const updates = [];
  const params = [];
  const changedFields = [];

  for (const field of EDITABLE_FIELDS) {
    if (fieldsToApply[field] !== undefined) {
      params.push(fieldsToApply[field]);
      updates.push(`${field} = $${params.length}`);
      changedFields.push(field);
    }
  }
  if (!updates.length) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  params.push(req.params.id);
  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    ));
  } catch (err) {
    // The pre-check above closes the common case; this catches the rare
    // race of two requests linking the same erp_customer_id at once (see
    // customers_erp_customer_id_unique_idx, migration 069).
    if (err.code === "23505" && newErpId) {
      const conflict = await findErpCustomerIdConflict(newErpId, req.params.id);
      if (conflict) return res.status(409).json(conflict);
    }
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });

  if (autoUpgradeToBronze) {
    await pool.query(
      `INSERT INTO customer_level_audit (customer_id, old_tier, new_tier, reason, changed_by)
       VALUES ($1, 'potential', 'bronze', 'ERP ID assigned', $2)`,
      [req.params.id, req.user.id]
    );
  }

  // A pending edit request captures its proposed changes at submission
  // time -- if a field it proposes to change gets set directly here first
  // (an admin/director fixing it on the spot, e.g.), approving that older
  // request later would silently reapply its now-stale value right back
  // over the fresher direct edit, with no visible error either time.
  // Reported live as "I changed a customer's sales channel and it later
  // reverted" -- an earlier pending request for that same customer/field
  // got approved after this direct edit. Strip the now-stale fields from
  // any pending request for this customer, auto-rejecting it only if that
  // empties it out entirely; any other fields it still proposes are left
  // untouched for a human to review normally.
  const { rows: pendingRequests } = await pool.query(
    "SELECT id, changes FROM customer_edit_requests WHERE customer_id = $1 AND status = 'pending'",
    [req.params.id]
  );
  for (const pr of pendingRequests) {
    const remaining = { ...pr.changes };
    let stale = false;
    for (const field of changedFields) {
      if (remaining[field] !== undefined) {
        delete remaining[field];
        stale = true;
      }
    }
    if (!stale) continue;
    if (Object.keys(remaining).length) {
      await pool.query("UPDATE customer_edit_requests SET changes = $1 WHERE id = $2", [
        JSON.stringify(remaining),
        pr.id,
      ]);
    } else {
      await pool.query(
        `UPDATE customer_edit_requests
         SET status = 'rejected', reviewed_by = $1, reviewed_at = now(),
             note = COALESCE(note || ' — ', '') || 'Auto-rejected: superseded by a direct edit'
         WHERE id = $2`,
        [req.user.id, pr.id]
      );
    }
  }

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
    // payments.customer_id is ON DELETE RESTRICT (payment records must
    // survive a customer being removed) -- any customer with recorded
    // payments hits this every time, so give a message that actually says
    // why instead of bubbling a raw FK-violation 500.
    if (err.code === "23503") {
      return res.status(409).json({
        error: "Can't delete this customer: it has recorded payments, which must be kept for the audit trail.",
      });
    }
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
  const { rows: customerRows } = await pool.query("SELECT erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  const erpCustomerId = customerRows[0]?.erp_customer_id;
  if (!erpCustomerId) return res.json([]);
  if (!seesCustomerErpData(req.user.role, customerRows[0].assigned_manager_id, req.user.id)) return res.json([]);

  const dateFilter = scope === "recent" ? "AND order_date >= now() - interval '3 months'" : "";
  const { rows } = await pool.query(
    `SELECT order_id, order_date, sum(revenue_amd) AS total_amd
     FROM erp_order_lines
     WHERE erp_customer_id = $1 ${dateFilter}
     GROUP BY order_id, order_date
     ORDER BY order_date DESC, order_id DESC
     LIMIT 10000`,
    [erpCustomerId]
  );
  res.json(rows);
});

// Payments received from one customer, newest first: the Excel Cashflow
// ("Oil order" rows, erp_cashflow_lines -- the trusted books) plus payments
// recorded in this app (pending/approved). An app payment that the Excel
// ledger already holds (same amount, within a few days) is hidden so the
// same money isn't listed twice.
customersRouter.get("/:id/payments-received", async (req, res) => {
  const { rows: customerRows } = await pool.query("SELECT id, erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [req.params.id]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const excel =
    customer.erp_customer_id && seesCustomerErpData(req.user.role, customer.assigned_manager_id, req.user.id)
      ? (
          await pool.query(
            "SELECT to_char(cashflow_date, 'YYYY-MM-DD') AS date, amount_amd FROM erp_cashflow_lines WHERE erp_customer_id = $1 ORDER BY cashflow_date DESC, id DESC",
            [customer.erp_customer_id]
          )
        ).rows
      : [];

  const appParams = [customer.id];
  let appScope = "";
  if (req.user.role === "sales_manager") {
    appParams.push(req.user.id);
    appScope = "AND sales_manager_id = $2";
  }
  const app = (
    await pool.query(
      `SELECT to_char(payment_date AT TIME ZONE 'Asia/Yerevan', 'YYYY-MM-DD') AS date, amount_amd, status, sales_manager_name_snapshot AS manager_name
       FROM payments WHERE customer_id = $1 AND status IN ('pending', 'approved') ${appScope}
       ORDER BY payment_date DESC, id DESC`,
      appParams
    )
  ).rows;

  const DAY = 24 * 3600 * 1000;
  const unmatched = excel.map((r) => ({ ts: new Date(r.date).getTime(), amount: Number(r.amount_amd), used: false }));
  const appRows = [];
  for (const p of app) {
    const ts = new Date(p.date).getTime();
    const hit = unmatched.find((e) => !e.used && e.amount === Number(p.amount_amd) && Math.abs(e.ts - ts) <= 5 * DAY);
    if (hit) {
      hit.used = true;
      continue;
    }
    appRows.push({ date: p.date, amount_amd: Number(p.amount_amd), source: "app", status: p.status, manager_name: p.manager_name });
  }
  const rows = [...excel.map((r) => ({ date: r.date, amount_amd: Number(r.amount_amd), source: "excel" })), ...appRows].sort(
    (a, b) => String(b.date).localeCompare(String(a.date))
  );
  res.json({ rows, total_amd: rows.reduce((sum, r) => sum + r.amount_amd, 0) });
});

// Line-item detail for one order (product/brand/qty/price), for the
// click-into-an-order view. Grouped by brand client-side.
customersRouter.get("/:id/erp-orders/:orderId", async (req, res) => {
  const { rows: customerRows } = await pool.query("SELECT erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  const erpCustomerId = customerRows[0]?.erp_customer_id;
  if (!erpCustomerId) return res.status(404).json({ error: "Customer not linked to an ERP record" });
  if (!seesCustomerErpData(req.user.role, customerRows[0].assigned_manager_id, req.user.id)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const { rows } = await pool.query(
    `SELECT order_id, order_date, product_id, brand, product_name, size_l, qty, unit_price_amd, revenue_amd, discount_amd
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
// Individually negotiated prices (Gold customers only) -- the order form
// shows these instead of the tier list price.
customersRouter.get("/:id/product-prices", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid customer id" });
  const { rows } = await pool.query(
    "SELECT product_id, price_amd FROM customer_product_prices WHERE customer_id = $1",
    [id]
  );
  res.json(rows.map((r) => ({ product_id: r.product_id, price_amd: Number(r.price_amd) })));
});

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

// When is this customer actually due a visit? Joins the three things that
// decide it, which used to live apart (the Map pin only knew the first):
//   1. approved one-off day plans (visit_plans) that include the customer,
//   2. recurring weekday rules (visit_plan_rules, set on Route Plans -- by
//      picked customers or by region/subregion) expanded to their next
//      dates; an explicit plan row for that rep+date overrides the rule,
//   3. the customer's own visit cadence (visit_frequency_days) from their
//      last check-in: the date by which they are due even if nobody planned.
// A sales manager only sees their own plans/rules.
const SCHEDULE_HORIZON_DAYS = 28;
const SCHEDULE_MAX_ENTRIES = 6;
// Everything about the plans that does not depend on one customer, loaded
// once per request so the single-customer and the batch (map pins) paths
// share it.
async function loadScheduleContext(req) {
  const today = yerevanToday();
  const ownOnly = req.user.role === "sales_manager";
  const { rows: ruleRows } = await pool.query(
    `SELECT r.*, u.name AS user_name FROM visit_plan_rules r JOIN users u ON u.id = r.user_id
     WHERE r.active ${ownOnly ? "AND r.user_id = $1" : ""}`,
    ownOnly ? [req.user.id] : []
  );
  const endDate = new Date(`${today}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + SCHEDULE_HORIZON_DAYS);
  const end = endDate.toISOString().slice(0, 10);
  const { rows: planRows } = await pool.query(
    `SELECT p.user_id, p.plan_date::text AS plan_date, p.status, p.customer_ids, u.name AS user_name
     FROM visit_plans p JOIN users u ON u.id = p.user_id
     WHERE p.plan_date BETWEEN $1 AND $2 ${ownOnly ? "AND p.user_id = $3" : ""}`,
    ownOnly ? [today, end, req.user.id] : [today, end]
  );
  // The due date is the same for everyone, so a plain manager's own-only rule
  // list is widened to every active rule for that part.
  const allRules = ownOnly ? (await pool.query(`SELECT day_of_week, customer_ids, areas FROM visit_plan_rules WHERE active`)).rows : ruleRows;
  return { today, ruleRows, planRows, allRules, planByUserDate: new Map(planRows.map((p) => [`${p.user_id}:${p.plan_date}`, p])) };
}

// customer: { id, region, subregion, visit_frequency_days, last_visit_at }
function scheduleForCustomer(customer, ctx) {
  const { today, ruleRows, planRows, allRules, planByUserDate } = ctx;
  const customerId = customer.id;
  const matchingRules = ruleRows.filter(
    (r) =>
      (r.customer_ids ?? []).includes(customerId) ||
      (Array.isArray(r.areas) &&
        r.areas.some((a) => a?.region && a.region === customer.region && (!a.subregion || a.subregion === customer.subregion)))
  );
  const planned = new Map(); // `${date}:${user_id}` -> entry
  // Explicit approved plans that include this customer.
  for (const p of planRows) {
    if (p.status === "approved" && (p.customer_ids ?? []).includes(customerId)) {
      planned.set(`${p.plan_date}:${p.user_id}`, { date: p.plan_date, user_id: p.user_id, user_name: p.user_name, source: "plan" });
    }
  }
  // Recurring rules, expanded day by day (an explicit row for that rep+date wins).
  if (matchingRules.length) {
    for (let i = 0; i < SCHEDULE_HORIZON_DAYS; i++) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      for (const r of matchingRules) {
        if (r.day_of_week !== dow) continue;
        if (planByUserDate.has(`${r.user_id}:${date}`)) continue;
        planned.set(`${date}:${r.user_id}`, { date, user_id: r.user_id, user_name: r.user_name, source: "rule" });
      }
    }
  }
  const plannedList = [...planned.values()].sort((a, b) => a.date.localeCompare(b.date) || a.user_name.localeCompare(b.user_name)).slice(0, SCHEDULE_MAX_ENTRIES);
  const due = computeVisitDue({
    lastVisitAt: customer.last_visit_at,
    frequencyDays: customer.visit_frequency_days,
    ruleWeekdays: ruleWeekdaysFor(customer, allRules),
    today,
  });
  return {
    today,
    planned: plannedList,
    planned_today: plannedList.some((p) => p.date === today),
    cadence: {
      frequency_days: Number(customer.visit_frequency_days) || null,
      last_visit_at: customer.last_visit_at,
      due_by: due.planned_date,
      planned_date: due.planned_date,
      overdue: due.overdue && !due.never_visited,
      overdue_days: due.overdue_days,
      never_visited: due.never_visited,
    },
  };
}

async function buildVisitSchedule(req, customerId) {
  const { rows: custRows } = await pool.query(
    `SELECT c.id, c.region, c.subregion, c.visit_frequency_days,
            (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range) AS last_visit_at
     FROM customers c WHERE c.id = $1`,
    [customerId]
  );
  if (!custRows[0]) return null;
  return scheduleForCustomer(custRows[0], await loadScheduleContext(req));
}

customersRouter.get("/:id/visit-schedule", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const schedule = await buildVisitSchedule(req, customerId);
  if (!schedule) return res.status(404).json({ error: "Customer not found" });
  res.json(schedule);
});

// Everything the Map pin popup shows beyond the name, in ONE small request
// (the full GET /:id drags ERP order history along): last visit, debt, plan.
customersRouter.get("/:id/map-facts", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const [schedule, { rows }] = await Promise.all([
    buildVisitSchedule(req, customerId),
    pool.query(
      `SELECT c.assigned_manager_id, erp.debt_amd
       FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
       WHERE c.id = $1`,
      [customerId]
    ),
  ]);
  if (!schedule || !rows[0]) return res.status(404).json({ error: "Customer not found" });
  const sees = seesCustomerErpData(req.user.role, rows[0].assigned_manager_id, req.user.id);
  res.json({ ...schedule, last_visit_at: schedule.cadence.last_visit_at, erp_debt_amd: sees ? rows[0].debt_amd : null });
});

// Credit terms (migration 101). The order form reads the current position to warn
// before an order goes over the limit; the accountant/directors set the limit.
customersRouter.get("/:id/credit-status", async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const { rows } = await pool.query("SELECT assigned_manager_id FROM customers WHERE id = $1", [customerId]);
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  if (!seesCustomerErpData(req.user.role, rows[0].assigned_manager_id, req.user.id)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const snap = await creditSnapshot(pool, customerId);
  res.json({ limit: snap.limit, debt_amd: snap.debt, open_orders_amd: snap.openOrders });
});

customersRouter.get("/:id/credit-history", async (req, res) => {
  if (!canSetCreditTerms(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const { rows } = await pool.query(
    `SELECT l.id, l.old_limit, l.new_limit, l.changed_at, u.name AS changed_by_name
     FROM customer_credit_limit_log l LEFT JOIN users u ON u.id = l.changed_by
     WHERE l.customer_id = $1 ORDER BY l.changed_at DESC, l.id DESC LIMIT 20`,
    [customerId]
  );
  res.json(rows.map((r) => ({ ...r, old_limit: r.old_limit === null ? null : Number(r.old_limit), new_limit: r.new_limit === null ? null : Number(r.new_limit) })));
});

customersRouter.put("/:id/credit-terms", async (req, res) => {
  if (!canSetCreditTerms(req.user.role)) return res.status(403).json({ error: "Only the accountant or a director can set credit terms" });
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const raw = req.body?.credit_limit_amd;
  let limit = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    limit = Math.round(Number(raw));
    if (!Number.isFinite(limit) || limit < 0 || limit >= 1e13) return res.status(400).json({ error: "credit_limit_amd must be a non-negative amount (empty = no limit)" });
  }
  const { rows: beforeRows } = await pool.query("SELECT credit_limit_amd FROM customers WHERE id = $1", [customerId]);
  if (!beforeRows[0]) return res.status(404).json({ error: "Customer not found" });
  const oldLimit = beforeRows[0].credit_limit_amd === null ? null : Number(beforeRows[0].credit_limit_amd);
  const { rows } = await pool.query("UPDATE customers SET credit_limit_amd = $2 WHERE id = $1 RETURNING id, credit_limit_amd", [customerId, limit]);
  // Append-only trail of who changed the limit (only real changes are logged).
  if (oldLimit !== limit) {
    await pool.query("INSERT INTO customer_credit_limit_log (customer_id, old_limit, new_limit, changed_by) VALUES ($1, $2, $3, $4)", [customerId, oldLimit, limit, req.user.id]);
  }
  res.json({ id: rows[0].id, credit_limit_amd: rows[0].credit_limit_amd === null ? null : Number(rows[0].credit_limit_amd) });
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
