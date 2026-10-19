// The only data Ask KAD's model can see: a handful of READ-ONLY questions, each answered by one SQL query
// that returns codes (CUST-<ERP id>, REP-<user id>) and numbers, never a name, phone, TIN, address or
// free-text note. The numbers come from the same sources the app's own screens use (ERP order lines =
// the invoiced truth, ERP customer debt, field-rep check-ins), so the answer cannot disagree with the app.
import { pool } from "../db/pool.js";
import { customerCode, repCode } from "./anonymize.js";
import { repVisitSql } from "../visitCount.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366 * 5;
const MAX_ROWS = 50;

const SIZE = (col) =>
  `(CASE WHEN regexp_replace(trim(${col}), '[Ll]$', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN regexp_replace(trim(${col}), '[Ll]$', '')::numeric ELSE 0 END)`;

const day = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => new Date(day(s).getTime() + n * 86400000).toISOString().slice(0, 10);
const limitOf = (v, dflt) => Math.min(Math.max(Math.trunc(Number(v)) || dflt, 1), MAX_ROWS);
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function period(input, today) {
  const from = DATE_RE.test(input?.from ?? "") ? input.from : `${today.slice(0, 7)}-01`;
  const to = DATE_RE.test(input?.to ?? "") ? input.to : today;
  if (to < from) throw new Error("`to` is before `from`");
  if ((day(to) - day(from)) / 86400000 > MAX_DAYS) throw new Error("period longer than 5 years");
  return { from, to };
}

// Customers every rep may check in at (the office) are not visits.
const NOT_OFFICE = "NOT EXISTS (SELECT 1 FROM customers oc WHERE oc.id = ch.customer_id AND oc.checkin_for_all)";

const DATES = {
  from: { type: "string", description: "First day, YYYY-MM-DD. Default: first day of the current month." },
  to: { type: "string", description: "Last day, YYYY-MM-DD. Default: today." },
};

export const TOOLS = [
  {
    name: "sales",
    description:
      "Invoiced sales from the ERP order lines (the trusted Excel truth) for a period: revenue in AMD, liters, orders and distinct customers, in total and grouped. " +
      "Orders made in the app but not yet in the ERP are not included. Call it twice (two periods) to compare. Customers appear as CUST-<id> codes.",
    input_schema: {
      type: "object",
      properties: {
        ...DATES,
        group_by: {
          type: "string",
          enum: ["month", "brand", "channel", "region", "customer", "product"],
          description: "How to split the total. Omit for the total only. `channel` is the selling channel (SM YVN, CVO, ...).",
        },
        brand: { type: "string", description: "Only this brand, e.g. Castrol (case-insensitive, exact)." },
        channel: { type: "string", description: "Only this selling channel (exact, case-insensitive)." },
        region: { type: "string", description: "Only customers in this region (exact, case-insensitive)." },
        limit: { type: "integer", description: "Max rows when grouped (default 15, max 50). Sorted by revenue, months in time order." },
      },
    },
  },
  {
    name: "debt",
    description:
      "Customers who owe money (ERP debt, AMD): total, split by aging bucket, and the biggest debtors with days since their last payment. Customers appear as CUST-<id> codes.",
    input_schema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Only customers in this region (exact, case-insensitive)." },
        channel: { type: "string", description: "Only customers assigned to this sales channel/rep label (exact, case-insensitive)." },
        limit: { type: "integer", description: "How many biggest debtors to list (default 15, max 50)." },
      },
    },
  },
  {
    name: "lapsed_customers",
    description:
      "Customers who used to buy but have not ordered for a while (win-back list): last order date, days since, and what they bought in the 12 months before they went quiet. Biggest first. Customers appear as CUST-<id> codes.",
    input_schema: {
      type: "object",
      properties: {
        min_days: { type: "integer", description: "No order for at least this many days (default 60)." },
        region: { type: "string", description: "Only customers in this region (exact, case-insensitive)." },
        limit: { type: "integer", description: "Max rows (default 15, max 50)." },
      },
    },
  },
  {
    name: "visits",
    description:
      "Field-rep activity in the app for a period: visits (check-ins by sales reps), distinct customers visited, average visit minutes, orders made in the app (count and AMD), and cash collected. Grouped per rep (REP-<id> codes) or per day.",
    input_schema: {
      type: "object",
      properties: {
        ...DATES,
        group_by: { type: "string", enum: ["rep", "day"], description: "Default rep." },
      },
    },
  },
  {
    name: "plan_vs_actual",
    description:
      "The approved monthly sales plan per channel against ERP revenue so far, with percent of plan reached. Use today's date to judge whether a channel is on pace.",
    input_schema: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM. Default: the current month." } },
    },
  },
];

const eqCi = (col, idx) => `lower(${col}) = lower($${idx})`;

const RUNNERS = {
  async sales(input, { db, today }) {
    const { from, to } = period(input, today);
    const params = [from, to];
    const conds = [];
    for (const [key, col] of [["brand", "l.brand"], ["channel", "l.channel"], ["region", "l.region"]]) {
      if (input?.[key]) {
        params.push(String(input[key]).trim());
        conds.push(eqCi(col, params.length));
      }
    }
    const base = `
      WITH l AS (
        SELECT eol.order_date AS d, eol.erp_customer_id, eol.order_id, eol.brand, eol.product_name, eol.size_l,
               eol.revenue_amd, eol.sales_rep AS channel, c.region,
               eol.qty * ${SIZE("eol.size_l")} AS liters
          FROM erp_order_lines eol LEFT JOIN customers c ON c.erp_customer_id = eol.erp_customer_id
         WHERE eol.order_date BETWEEN $1 AND $2 AND eol.erp_customer_id <> '10000')
      SELECT %KEY% COALESCE(sum(revenue_amd), 0) AS revenue_amd, COALESCE(sum(liters), 0) AS liters,
             count(DISTINCT erp_customer_id || ':' || order_id) AS orders, count(DISTINCT erp_customer_id) AS customers
        FROM l ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}`;
    const shape = (r) => ({ revenue_amd: Math.round(num(r.revenue_amd)), liters: Math.round(num(r.liters) * 10) / 10, orders: num(r.orders), customers: num(r.customers) });
    const { rows: tot } = await db.query(base.replace("%KEY%", ""), params);
    const out = { from, to, total: shape(tot[0]) };
    const by = input?.group_by;
    const KEYS = {
      month: "to_char(d, 'YYYY-MM')",
      brand: "COALESCE(brand, '—')",
      channel: "COALESCE(channel, '—')",
      region: "COALESCE(region, '—')",
      customer: "'CUST-' || erp_customer_id",
      product: "trim(concat_ws(' ', product_name, size_l))",
    };
    if (by && KEYS[by]) {
      const order = by === "month" ? "1 ASC" : "revenue_amd DESC";
      const { rows } = await db.query(`${base.replace("%KEY%", `${KEYS[by]} AS k,`)} GROUP BY 1 ORDER BY ${order} LIMIT ${limitOf(input.limit, 15)}`, params);
      out.group_by = by;
      out.rows = rows.map((r) => ({ [by]: r.k, ...shape(r) }));
    }
    return out;
  },

  async debt(input, { db }) {
    const params = [];
    const conds = ["e.debt_amd > 0", "e.erp_customer_id <> '10000'"];
    if (input?.region) {
      params.push(String(input.region).trim());
      conds.push(eqCi("c.region", params.length));
    }
    if (input?.channel) {
      params.push(String(input.channel).trim());
      conds.push(eqCi("e.assigned_sales_rep", params.length));
    }
    const from = `FROM erp_customer_data e LEFT JOIN customers c ON c.erp_customer_id = e.erp_customer_id WHERE ${conds.join(" AND ")}`;
    const [{ rows: tot }, { rows: buckets }, { rows: top }] = await Promise.all([
      db.query(`SELECT COALESCE(sum(e.debt_amd), 0) AS total, count(*) AS customers ${from}`, params),
      db.query(`SELECT COALESCE(e.aging_bucket, 'unknown') AS bucket, sum(e.debt_amd) AS amd, count(*) AS customers ${from} GROUP BY 1 ORDER BY 2 DESC`, params),
      db.query(
        `SELECT e.erp_customer_id, e.debt_amd, e.aging_bucket, e.days_since_payment, e.last_payment_date, e.assigned_sales_rep AS channel, c.region
           ${from} ORDER BY e.debt_amd DESC LIMIT ${limitOf(input?.limit, 15)}`,
        params
      ),
    ]);
    return {
      total_debt_amd: Math.round(num(tot[0].total)),
      customers_with_debt: num(tot[0].customers),
      by_aging_bucket: buckets.map((b) => ({ bucket: b.bucket, amd: Math.round(num(b.amd)), customers: num(b.customers) })),
      biggest: top.map((r) => ({
        customer: customerCode(r.erp_customer_id),
        debt_amd: Math.round(num(r.debt_amd)),
        aging_bucket: r.aging_bucket,
        days_since_payment: r.days_since_payment,
        last_payment_date: r.last_payment_date ? new Date(r.last_payment_date).toISOString().slice(0, 10) : null,
        channel: r.channel,
        region: r.region,
      })),
    };
  },

  async lapsed_customers(input, { db, today }) {
    const minDays = Math.min(Math.max(Math.trunc(Number(input?.min_days)) || 60, 7), 1000);
    const cutoff = addDays(today, -minDays);
    const params = [cutoff, addDays(cutoff, -365)];
    let regionCond = "";
    if (input?.region) {
      params.push(String(input.region).trim());
      regionCond = `AND ${eqCi("c.region", params.length)}`;
    }
    const { rows } = await db.query(
      `SELECT eol.erp_customer_id, max(eol.order_date) AS last_order,
              sum(eol.revenue_amd) FILTER (WHERE eol.order_date > $2::date) AS revenue_before,
              count(DISTINCT eol.order_id) FILTER (WHERE eol.order_date > $2::date) AS orders_before,
              (array_agg(eol.sales_rep ORDER BY eol.order_date DESC))[1] AS channel, max(c.region) AS region
         FROM erp_order_lines eol LEFT JOIN customers c ON c.erp_customer_id = eol.erp_customer_id
        WHERE eol.erp_customer_id <> '10000' ${regionCond}
        GROUP BY eol.erp_customer_id
       HAVING max(eol.order_date) <= $1::date AND COALESCE(sum(eol.revenue_amd) FILTER (WHERE eol.order_date > $2::date), 0) > 0
        ORDER BY revenue_before DESC LIMIT ${limitOf(input?.limit, 15)}`,
      params
    );
    return {
      no_order_for_days: minDays,
      customers: rows.map((r) => {
        const last = new Date(r.last_order).toISOString().slice(0, 10);
        return {
          customer: customerCode(r.erp_customer_id),
          last_order: last,
          days_since_last_order: Math.round((day(today) - day(last)) / 86400000),
          revenue_in_year_before_amd: Math.round(num(r.revenue_before)),
          orders_in_year_before: num(r.orders_before),
          channel: r.channel,
          region: r.region,
        };
      }),
    };
  },

  async visits(input, { db, today }) {
    const { from, to } = period(input, today);
    const D = "(ch.timestamp AT TIME ZONE 'Asia/Yerevan')::date";
    if (input?.group_by === "day") {
      const { rows } = await db.query(
        `SELECT ${D} AS d, count(*) AS visits, count(DISTINCT ch.customer_id) AS customers, count(DISTINCT ch.user_id) AS reps
           FROM checkins ch WHERE ${repVisitSql("ch")} AND ${NOT_OFFICE} AND ${D} BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
        [from, to]
      );
      return { from, to, days: rows.map((r) => ({ date: new Date(r.d).toISOString().slice(0, 10), visits: num(r.visits), customers: num(r.customers), reps: num(r.reps) })) };
    }
    const O = "(o.created_at AT TIME ZONE 'Asia/Yerevan')::date";
    const { rows } = await db.query(
      `SELECT u.id,
              (SELECT count(*) FROM checkins ch WHERE ch.user_id = u.id AND ${NOT_OFFICE} AND ${D} BETWEEN $1 AND $2) AS visits,
              (SELECT count(DISTINCT ch.customer_id) FROM checkins ch WHERE ch.user_id = u.id AND ${NOT_OFFICE} AND ${D} BETWEEN $1 AND $2) AS customers,
              (SELECT round(avg(EXTRACT(EPOCH FROM ch.ended_at - ch.timestamp) / 60)) FROM checkins ch
                WHERE ch.user_id = u.id AND ${NOT_OFFICE} AND ch.ended_at IS NOT NULL AND ch.ended_at - ch.timestamp < interval '8 hours' AND ${D} BETWEEN $1 AND $2) AS avg_visit_minutes,
              (SELECT count(*) FROM orders o WHERE o.user_id = u.id AND o.status <> 'draft' AND ${O} BETWEEN $1 AND $2) AS app_orders,
              (SELECT COALESCE(sum(o.total_amd), 0) FROM orders o WHERE o.user_id = u.id AND o.status <> 'draft' AND ${O} BETWEEN $1 AND $2) AS app_orders_amd,
              (SELECT COALESCE(sum(p.amount_amd), 0) FROM payments p WHERE p.sales_manager_id = u.id AND p.status = 'approved'
                AND (p.approved_at AT TIME ZONE 'Asia/Yerevan')::date BETWEEN $1 AND $2) AS collected_amd
         FROM users u WHERE u.role = 'sales_manager' ORDER BY visits DESC`,
      [from, to]
    );
    return {
      from,
      to,
      reps: rows.map((r) => ({
        rep: repCode(r.id),
        visits: num(r.visits),
        customers_visited: num(r.customers),
        avg_visit_minutes: r.avg_visit_minutes === null ? null : num(r.avg_visit_minutes),
        app_orders: num(r.app_orders),
        app_orders_amd: Math.round(num(r.app_orders_amd)),
        collected_amd: Math.round(num(r.collected_amd)),
      })),
    };
  },

  async plan_vs_actual(input, { db, today }) {
    const month = /^\d{4}-\d{2}$/.test(input?.month ?? "") ? input.month : today.slice(0, 7);
    const first = `${month}-01`;
    const { rows: plan } = await db.query(
      `SELECT sc.code, sc.name, pt.sales_target_amd, pt.collection_target_amd, pt.new_customers_target
         FROM perf_plans p JOIN perf_plan_targets pt ON pt.plan_id = p.id JOIN sales_channels sc ON sc.id = pt.channel_id
        WHERE p.month = $1::date AND p.status IN ('approved', 'closed')
          AND p.version = (SELECT max(version) FROM perf_plans WHERE month = $1::date AND status IN ('approved', 'closed'))
        ORDER BY sc.display_order`,
      [first]
    );
    const { rows: actual } = await db.query(
      `SELECT upper(trim(sales_rep)) AS channel, sum(revenue_amd) AS revenue
         FROM erp_order_lines
        WHERE order_date >= $1::date AND order_date < ($1::date + interval '1 month') AND erp_customer_id <> '10000'
        GROUP BY 1`,
      [first]
    );
    const byChannel = new Map(actual.map((a) => [a.channel, num(a.revenue)]));
    const used = new Set();
    const channels = plan.map((p) => {
      const key = String(p.code ?? "").trim().toUpperCase();
      const nameKey = String(p.name ?? "").trim().toUpperCase();
      const k = byChannel.has(key) ? key : byChannel.has(nameKey) ? nameKey : null;
      if (k) used.add(k);
      const revenue = k ? byChannel.get(k) : 0;
      const target = num(p.sales_target_amd);
      return {
        channel: p.code,
        sales_target_amd: Math.round(target),
        revenue_so_far_amd: Math.round(revenue),
        percent_of_plan: target > 0 ? Math.round((revenue / target) * 100) : null,
        collection_target_amd: Math.round(num(p.collection_target_amd)),
        new_customers_target: p.new_customers_target,
      };
    });
    return {
      month,
      today,
      plan_found: plan.length > 0,
      channels,
      revenue_in_channels_without_a_plan_amd: Math.round([...byChannel].filter(([k]) => !used.has(k)).reduce((s, [, v]) => s + v, 0)),
    };
  },
};

// Runs one tool; always returns a JSON string (an error is a JSON string the model can read and react to).
export async function runTool(name, input, { db = pool, today }) {
  const run = RUNNERS[name];
  if (!run) return { isError: true, content: JSON.stringify({ error: `unknown tool ${name}` }) };
  try {
    return { isError: false, content: JSON.stringify(await run(input ?? {}, { db, today })) };
  } catch (err) {
    return { isError: true, content: JSON.stringify({ error: String(err.message ?? err) }) };
  }
}
