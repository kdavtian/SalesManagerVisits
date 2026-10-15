// Numbers behind the Operations control page (see routes/opsControl.js). Every report answers a decision:
// price realization (are we discounting too much?), USD/AMD drift (do prices need a review?), dead stock (what do we
// do with it?), win-back (does chasing lapsed customers work?), order flow (where do orders wait?), data scorecard
// (what is broken in the data?), Excel upload (did today's workbook arrive?).
import { pool } from "./db/pool.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { getVaghinakSettings } from "./vaghinak/settings.js";
import { createOpsTask, closeOpsTasks, usersWithRole } from "./opsTasks.js";

const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;

// ---------- price realization (Excel order lines vs Silver list and landing cost) ----------
export async function priceRealization(db = pool, days = 90) {
  const today = yerevanToday();
  const base = `
    FROM erp_order_lines l
    LEFT JOIN products p ON lower(p.erp_product_id) = lower(l.product_id)
    WHERE l.order_date >= $1::date - $2::int AND l.erp_customer_id <> '10000' AND COALESCE(l.qty, 0) > 0 AND COALESCE(l.revenue_amd, 0) > 0`;
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(l.sales_rep, ''), '-') AS channel, count(*)::int AS lines,
            sum(l.revenue_amd)::float8 AS revenue,
            sum(l.qty * NULLIF(regexp_replace(COALESCE(l.size_l, ''), '[^0-9.]', '', 'g'), '')::numeric)::float8 AS liters,
            sum(l.qty * p.silver_price_amd) FILTER (WHERE p.silver_price_amd > 0)::float8 AS silver_value,
            sum(l.revenue_amd) FILTER (WHERE p.silver_price_amd > 0)::float8 AS revenue_vs_silver,
            sum(l.qty * p.landing_cost_amd) FILTER (WHERE p.landing_cost_amd > 0)::float8 AS cost,
            sum(l.revenue_amd) FILTER (WHERE p.landing_cost_amd > 0)::float8 AS revenue_vs_cost,
            count(*) FILTER (WHERE p.landing_cost_amd > 0 AND l.revenue_amd / l.qty < p.landing_cost_amd - 0.5)::int AS below_landing_lines
     ${base} GROUP BY 1 ORDER BY revenue DESC`,
    [today, days]
  );
  const channels = rows.map((r) => ({
    channel: r.channel,
    lines: r.lines,
    revenue_amd: Math.round(r.revenue),
    liters: Math.round(r.liters ?? 0),
    realization_pct: r.silver_value > 0 ? Math.round((r.revenue_vs_silver / r.silver_value) * 1000) / 10 : null,
    margin_pct: r.revenue_vs_cost > 0 ? Math.round(((r.revenue_vs_cost - r.cost) / r.revenue_vs_cost) * 1000) / 10 : null,
    below_landing_lines: r.below_landing_lines,
  }));
  const totals = rows.reduce((a, r) => ({ rev: a.rev + r.revenue, sv: a.sv + (r.silver_value ?? 0), rvs: a.rvs + (r.revenue_vs_silver ?? 0), cost: a.cost + (r.cost ?? 0), rvc: a.rvc + (r.revenue_vs_cost ?? 0) }), { rev: 0, sv: 0, rvs: 0, cost: 0, rvc: 0 });
  const { rows: worst } = await db.query(
    `SELECT to_char(l.order_date, 'YYYY-MM-DD') AS order_date, l.order_id, COALESCE(c.name, erp.customer_name, l.erp_customer_id) AS customer,
            COALESCE(p.name, l.product_name) AS product, l.qty::float8 AS qty, (l.revenue_amd / l.qty)::float8 AS price,
            p.landing_cost_amd::float8 AS landing, ((p.landing_cost_amd - l.revenue_amd / l.qty) * l.qty)::float8 AS loss,
            COALESCE(NULLIF(l.sales_rep, ''), '-') AS channel
     FROM erp_order_lines l
     JOIN products p ON lower(p.erp_product_id) = lower(l.product_id)
     LEFT JOIN customers c ON c.erp_customer_id = l.erp_customer_id
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = l.erp_customer_id
     WHERE l.order_date >= $1::date - $2::int AND l.erp_customer_id <> '10000' AND COALESCE(l.qty, 0) > 0 AND COALESCE(l.revenue_amd, 0) > 0
       AND p.landing_cost_amd > 0 AND l.revenue_amd / l.qty < p.landing_cost_amd - 0.5
     ORDER BY loss DESC LIMIT 25`,
    [today, days]
  );
  return {
    days,
    total: {
      revenue_amd: Math.round(totals.rev),
      realization_pct: totals.sv > 0 ? Math.round((totals.rvs / totals.sv) * 1000) / 10 : null,
      margin_pct: totals.rvc > 0 ? Math.round(((totals.rvc - totals.cost) / totals.rvc) * 1000) / 10 : null,
    },
    channels,
    below_landing: worst.map((w) => ({ ...w, loss: Math.round(w.loss), price: Math.round(w.price), landing: Math.round(w.landing) })),
  };
}

// ---------- USD/AMD rate review ----------
export const FX_REVIEW_PCT = 2;

export async function fxStatus(db = pool) {
  const { rows } = await db.query("SELECT id, rate::float8 AS rate, note, review_done, set_at FROM fx_rates ORDER BY id DESC LIMIT 12");
  if (!rows.length) return { current: null, baseline: null, drift_pct: null, needs_review: false, review_pct: FX_REVIEW_PCT, history: [] };
  const current = rows[0];
  const baseline = rows.find((r) => r.review_done) ?? rows[rows.length - 1];
  const drift = baseline.rate > 0 ? ((current.rate - baseline.rate) / baseline.rate) * 100 : 0;
  return {
    current,
    baseline,
    drift_pct: Math.round(drift * 100) / 100,
    needs_review: Math.abs(drift) >= FX_REVIEW_PCT && !current.review_done,
    review_pct: FX_REVIEW_PCT,
    history: rows,
  };
}

export async function setFxRate(rate, userId, note = null, db = pool) {
  await db.query("INSERT INTO fx_rates (rate, note, set_by) VALUES ($1, $2, $3)", [rate, note, userId]);
  const status = await fxStatus(db);
  if (status.needs_review) {
    const people = [...(await usersWithRole("sales_director", db)), ...(await usersWithRole("accountant", db))];
    const drift = `${status.drift_pct > 0 ? "+" : ""}${status.drift_pct}%`;
    for (const assigneeId of people) {
      await createOpsTask({
        kind: "fx_review",
        title: `Վերանայիր գները․ դոլարի փոխարժեքը փոխվել է ${drift}`,
        assigneeId,
        items: [`USD/AMD ${status.baseline.rate} → ${status.current.rate}`, "Ստուգիր վաճառքի գները և Excel-ի ինքնարժեքի փոխարժեքը", "Վերջում՝ Operations control → Margin → «Գները վերանայված են»"],
        db,
      });
    }
  }
  return status;
}

export async function fxReviewDone(userId, db = pool) {
  const { rows } = await db.query("SELECT rate FROM fx_rates ORDER BY id DESC LIMIT 1");
  if (!rows[0]) return null;
  await db.query("INSERT INTO fx_rates (rate, note, review_done, set_by) VALUES ($1, 'price review done', true, $2)", [rows[0].rate, userId]);
  await closeOpsTasks("fx_review", "Գները վերանայված են", db);
  return fxStatus(db);
}

// ---------- dead stock ----------
export const DEAD_STOCK_DAYS = 180;
export async function deadStock(db = pool) {
  const today = yerevanToday();
  const { rows } = await db.query(
    `WITH last_sale AS (
       SELECT lower(product_id) AS pid, MAX(order_date) AS last_sale FROM erp_order_lines
       WHERE COALESCE(qty, 0) > 0 AND erp_customer_id <> '10000' AND product_id IS NOT NULL GROUP BY 1
     )
     SELECT p.id AS product_id, p.name, p.brand, p.unit, p.stock_qty, p.landing_cost_amd::float8 AS landing, p.silver_price_amd::float8 AS silver,
            to_char(ls.last_sale, 'YYYY-MM-DD') AS last_sale, ($1::date - ls.last_sale) AS days_since_sale,
            a.action, a.note, to_char(a.due_date, 'YYYY-MM-DD') AS due_date, a.assignee_id, au.name AS assignee_name, a.task_id
     FROM products p
     LEFT JOIN last_sale ls ON ls.pid = lower(p.erp_product_id)
     LEFT JOIN stock_actions a ON a.product_id = p.id
     LEFT JOIN users au ON au.id = a.assignee_id
     WHERE p.active AND p.stock_qty > 0 AND p.created_at < now() - interval '60 days'
       AND (ls.last_sale IS NULL OR ls.last_sale < $1::date - ${DEAD_STOCK_DAYS})
     ORDER BY p.stock_qty * COALESCE(p.landing_cost_amd, 0) DESC`,
    [today]
  );
  const items = rows.map((r) => ({
    ...r,
    value_landing_amd: Math.round(r.stock_qty * (r.landing ?? 0)),
    value_silver_amd: Math.round(r.stock_qty * (r.silver ?? 0)),
  }));
  return {
    days: DEAD_STOCK_DAYS,
    total_landing_amd: items.reduce((s, r) => s + r.value_landing_amd, 0),
    total_silver_amd: items.reduce((s, r) => s + r.value_silver_amd, 0),
    undecided: items.filter((r) => !r.action).length,
    items,
  };
}

export const STOCK_ACTIONS = ["campaign", "bundle", "discount", "transfer", "keep"];
const ACTION_TITLE = { campaign: "Արշավ", bundle: "Փաթեթ", discount: "Զեղչ", transfer: "Տեղափոխում", keep: "Պահել" };

// Saves the decision and (unless "keep") gives somebody the task to sell it by the due date.
export async function setStockAction({ productId, action, note, dueDate, assigneeId, userId }, db = pool) {
  const { rows: pr } = await db.query("SELECT id, name, stock_qty FROM products WHERE id = $1", [productId]);
  if (!pr[0]) return null;
  let taskId = null;
  if (action !== "keep") {
    const assignee = assigneeId ?? (await usersWithRole("sales_director", db))[0] ?? userId;
    taskId = await createOpsTask({
      kind: "dead_stock",
      title: `Վաճառիր մնացորդը՝ ${pr[0].name} (${pr[0].stock_qty} հատ)`,
      assigneeId: assignee,
      dueDate: dueDate || yerevanToday(),
      items: [`${ACTION_TITLE[action]}${note ? `․ ${note}` : ""}`],
      db,
    });
    assigneeId = assignee;
  }
  await db.query(
    `INSERT INTO stock_actions (product_id, action, note, due_date, assignee_id, task_id, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (product_id) DO UPDATE SET action = EXCLUDED.action, note = EXCLUDED.note, due_date = EXCLUDED.due_date, assignee_id = EXCLUDED.assignee_id,
       task_id = COALESCE(EXCLUDED.task_id, stock_actions.task_id), set_by = EXCLUDED.set_by, set_at = now()`,
    [productId, action, note || null, dueDate || null, assigneeId ?? null, taskId, userId]
  );
  return { task_id: taskId };
}

// ---------- win-back: do the "he stopped ordering" tasks bring customers back? ----------
export async function winback(db = pool, weeks = 8) {
  const { rows } = await db.query(
    `WITH t AS (
       SELECT t.id, t.assignee_id, t.status, t.created_at, to_char(date_trunc('week', t.created_at AT TIME ZONE 'Asia/Yerevan')::date, 'YYYY-MM-DD') AS week, c.id AS customer_id, c.erp_customer_id
       FROM tasks t JOIN customers c ON c.id = t.customer_id
       WHERE t.auto_kind = 'reorder_followup' AND t.created_at >= now() - ($1 || ' weeks')::interval
     ), r AS (
       SELECT t.*,
         COALESCE((SELECT SUM(o.total_amd) FROM orders o WHERE o.customer_id = t.customer_id AND o.status NOT IN ('draft', 'cancelled', 'rejected') AND o.created_at > t.created_at), 0)::float8 AS app_amd,
         COALESCE((SELECT SUM(l.revenue_amd) FROM erp_order_lines l WHERE l.erp_customer_id = t.erp_customer_id AND l.order_date >= (t.created_at AT TIME ZONE 'Asia/Yerevan')::date AND COALESCE(l.qty, 0) > 0), 0)::float8 AS erp_amd
       FROM t
     )
     SELECT week, assignee_id, count(*)::int AS created, count(*) FILTER (WHERE status = 'done')::int AS done,
            count(*) FILTER (WHERE GREATEST(app_amd, erp_amd) > 0)::int AS returned, COALESCE(sum(GREATEST(app_amd, erp_amd)), 0)::float8 AS returned_amd
     FROM r GROUP BY week, assignee_id ORDER BY week DESC`,
    [weeks]
  );
  const names = new Map((await db.query("SELECT id, name FROM users WHERE id = ANY($1)", [[...new Set(rows.map((r) => r.assignee_id))]])).rows.map((u) => [u.id, u.name]));
  const byWeek = new Map();
  const byRep = new Map();
  for (const r of rows) {
    for (const [map, key, label] of [[byWeek, r.week, r.week], [byRep, r.assignee_id, names.get(r.assignee_id) ?? "?"]]) {
      const e = map.get(key) ?? { label, created: 0, done: 0, returned: 0, returned_amd: 0 };
      e.created += r.created;
      e.done += r.done;
      e.returned += r.returned;
      e.returned_amd += Math.round(r.returned_amd);
      map.set(key, e);
    }
  }
  const today = yerevanToday();
  const { rows: lapsed } = await db.query(
    `WITH last AS (SELECT erp_customer_id, MAX(order_date) AS last_order, SUM(revenue_amd) FILTER (WHERE order_date >= $1::date - 365)::float8 AS last_year
                   FROM erp_order_lines WHERE COALESCE(qty, 0) > 0 AND erp_customer_id <> '10000' GROUP BY 1)
     SELECT count(*) FILTER (WHERE last_order < $1::date - 90)::int AS lapsed, count(*) FILTER (WHERE last_order >= $1::date - 90)::int AS active,
            COALESCE(sum(last_year) FILTER (WHERE last_order < $1::date - 90), 0)::float8 AS lapsed_year_amd
     FROM last`,
    [today]
  );
  return {
    weeks,
    by_week: [...byWeek.values()],
    by_rep: [...byRep.values()].sort((a, b) => b.created - a.created),
    lapsed_customers: lapsed[0].lapsed,
    active_customers: lapsed[0].active,
    lapsed_year_amd: Math.round(lapsed[0].lapsed_year_amd),
  };
}

// ---------- order flow ----------
export async function orderFlow(db = pool, days = 30) {
  const settings = await getVaghinakSettings(db);
  const { rows: steps } = await db.query(
    `WITH t AS (
       SELECT o.id, o.created_at AS t_sub,
              MIN(h.changed_at) FILTER (WHERE h.new_status = 'confirmed') AS t_conf,
              MIN(h.changed_at) FILTER (WHERE h.new_status = 'packed_stock_out') AS t_pack,
              MIN(h.changed_at) FILTER (WHERE h.new_status = 'delivered') AS t_del
       FROM orders o LEFT JOIN order_status_history h ON h.order_id = o.id
       WHERE o.created_at >= now() - ($1 || ' days')::interval AND o.status <> 'draft' AND NOT COALESCE(o.delivered_from_erp, false)
       GROUP BY o.id
     )
     SELECT step, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY hrs)::float8 AS p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY hrs)::float8 AS p90 FROM (
       SELECT 'confirm' AS step, EXTRACT(EPOCH FROM (t_conf - t_sub)) / 3600 AS hrs FROM t WHERE t_conf IS NOT NULL
       UNION ALL SELECT 'pack', EXTRACT(EPOCH FROM (t_pack - t_conf)) / 3600 FROM t WHERE t_pack IS NOT NULL AND t_conf IS NOT NULL
       UNION ALL SELECT 'deliver', EXTRACT(EPOCH FROM (t_del - COALESCE(t_pack, t_conf))) / 3600 FROM t WHERE t_del IS NOT NULL AND COALESCE(t_pack, t_conf) IS NOT NULL
     ) x WHERE hrs >= 0 GROUP BY step`,
    [days]
  );
  const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  const stepMap = Object.fromEntries(steps.map((s) => [s.step, { n: s.n, p50_h: round1(s.p50), p90_h: round1(s.p90) }]));
  const sla = { confirm: settings.slaConfirmH, pack: settings.slaPackH, deliver: settings.slaDeliverH };
  const { rows: waiting } = await db.query(
    `SELECT o.id, o.order_code, o.status, o.total_amd::float8 AS total_amd, c.name AS customer_name, o.approval_status, o.credit_status,
            CASE o.status WHEN 'submitted' THEN o.created_at
                 WHEN 'confirmed' THEN COALESCE((SELECT MIN(changed_at) FROM order_status_history WHERE order_id = o.id AND new_status = 'confirmed'), o.updated_at)
                 ELSE COALESCE((SELECT MIN(changed_at) FROM order_status_history WHERE order_id = o.id AND new_status = 'packed_stock_out'), o.updated_at) END AS since
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('submitted', 'confirmed', 'packed_stock_out')
     ORDER BY since`
  );
  const now = Date.now();
  const stepOf = { submitted: "confirm", confirmed: "pack", packed_stock_out: "deliver" };
  const list = waiting.map((w) => {
    const hours = (now - new Date(w.since).getTime()) / 3.6e6;
    const step = stepOf[w.status];
    return {
      id: w.id,
      order_code: w.order_code,
      customer_name: w.customer_name,
      total_amd: Math.round(w.total_amd),
      step,
      waiting_h: round1(hours),
      over_sla: hours > sla[step],
      blocked_by: w.approval_status === "pending" ? "price_approval" : w.credit_status === "pending" ? "credit_approval" : null,
    };
  });
  return { days, sla, steps: stepMap, waiting: list.slice(0, 40), waiting_count: list.length, over_sla_count: list.filter((w) => w.over_sla).length };
}

// ---------- data scorecard ----------
export async function dataScorecard(db = pool) {
  const check = async (key, severity, countSql, sampleSql) => {
    const { rows } = await db.query(countSql);
    const count = Number(rows[0]?.n ?? 0);
    let samples = [];
    if (count > 0 && sampleSql) samples = (await db.query(sampleSql)).rows.map((r) => r.label);
    return { key, severity, count, samples };
  };
  const checks = await Promise.all([
    check("customers_no_channel", "fix", "SELECT count(*)::int AS n FROM customers WHERE COALESCE(sales_channel, '') = '' AND erp_customer_id <> '10000'", "SELECT name AS label FROM customers WHERE COALESCE(sales_channel, '') = '' AND erp_customer_id <> '10000' ORDER BY id DESC LIMIT 5"),
    check("customers_no_owner", "fix", "SELECT count(*)::int AS n FROM customers WHERE assigned_manager_id IS NULL AND NOT COALESCE(checkin_for_all, false)", "SELECT name AS label FROM customers WHERE assigned_manager_id IS NULL AND NOT COALESCE(checkin_for_all, false) ORDER BY id DESC LIMIT 5"),
    check("customers_no_erp_id", "fix", "SELECT count(*)::int AS n FROM customers WHERE erp_customer_id IS NULL", "SELECT name AS label FROM customers WHERE erp_customer_id IS NULL ORDER BY id DESC LIMIT 5"),
    check("customers_duplicate_erp_id", "fix", "SELECT count(*)::int AS n FROM (SELECT erp_customer_id FROM customers WHERE erp_customer_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d", "SELECT erp_customer_id AS label FROM customers WHERE erp_customer_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1 LIMIT 5"),
    check("customers_no_phone", "info", "SELECT count(*)::int AS n FROM customers WHERE COALESCE(phone, '') = '' AND erp_customer_id <> '10000'", null),
    check("customers_no_region", "info", "SELECT count(*)::int AS n FROM customers WHERE COALESCE(region, '') = '' AND erp_customer_id <> '10000'", null),
    check("customers_no_tin", "info", "SELECT count(*)::int AS n FROM customers WHERE COALESCE(tin, '') = '' AND erp_customer_id <> '10000'", null),
    check("price_below_landing", "fix", "SELECT count(*)::int AS n FROM products WHERE active AND landing_cost_amd > 0 AND ((silver_price_amd > 0 AND silver_price_amd < landing_cost_amd) OR (gold_price_amd > 0 AND gold_price_amd < landing_cost_amd))", "SELECT name AS label FROM products WHERE active AND landing_cost_amd > 0 AND ((silver_price_amd > 0 AND silver_price_amd < landing_cost_amd) OR (gold_price_amd > 0 AND gold_price_amd < landing_cost_amd)) ORDER BY name LIMIT 5"),
    check("price_gold_above_silver", "fix", "SELECT count(*)::int AS n FROM products WHERE active AND gold_price_amd > 0 AND silver_price_amd > 0 AND gold_price_amd > silver_price_amd", "SELECT name AS label FROM products WHERE active AND gold_price_amd > 0 AND silver_price_amd > 0 AND gold_price_amd > silver_price_amd ORDER BY name LIMIT 5"),
    check("products_no_price", "fix", "SELECT count(*)::int AS n FROM products WHERE active AND COALESCE(family, '') <> 'Merch' AND COALESCE(silver_price_amd, 0) = 0 AND COALESCE(bronze_price_amd, 0) = 0", "SELECT name AS label FROM products WHERE active AND COALESCE(family, '') <> 'Merch' AND COALESCE(silver_price_amd, 0) = 0 AND COALESCE(bronze_price_amd, 0) = 0 ORDER BY name LIMIT 5"),
    check("products_test_active", "fix", "SELECT count(*)::int AS n FROM products WHERE active AND (name ILIKE 'test%' OR brand ILIKE 'test%')", "SELECT name AS label FROM products WHERE active AND (name ILIKE 'test%' OR brand ILIKE 'test%') LIMIT 5"),
  ]);
  const excel = await excelStatus(db);
  if (excel.stale) checks.push({ key: "excel_stale", severity: "fix", count: 1, samples: [excel.synced_at ? String(excel.synced_at).slice(0, 16) : "never"] });
  return { checks, fix_count: checks.filter((c) => c.severity === "fix" && c.count > 0).length, excel };
}

// ---------- the daily Excel upload ----------
export async function excelStatus(db = pool, now = new Date()) {
  // (a sync "from the future" cannot exist; ignoring it also keeps tests with a fake clock honest)
  const { rows } = await db.query("SELECT MAX(synced_at) AS synced_at FROM erp_customer_data WHERE synced_at <= $1", [now]);
  const syncedAt = rows[0]?.synced_at ?? null;
  const dayStartUtc = new Date(`${yerevanToday(now)}T00:00:00Z`).getTime() - YEREVAN_OFFSET_MS;
  const hoursAgo = syncedAt ? (now.getTime() - new Date(syncedAt).getTime()) / 3.6e6 : null;
  return { synced_at: syncedAt, hours_ago: hoursAgo == null ? null : Math.round(hoursAgo * 10) / 10, today_synced: Boolean(syncedAt) && new Date(syncedAt).getTime() >= dayStartUtc, stale: hoursAgo == null || hoursAgo > 36 };
}
