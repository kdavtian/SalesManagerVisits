// "Products & liters" report: what was sold (liters, orders, customers -- liters only, no money), for any period, product, channel
// and place -- one engine behind every management question ("how many liters of Castrol this month / last
// year / YTD", "Magnatec 5W-30 C3 in Yerevan Ajapnyak", "Royal 0W-8 sold by SM YVN or CVO").
//
// Source: the ERP order lines (erp_order_lines, the invoiced truth from the Excel ORDERS sheet). Customer
// 10000 "Inventory" (the pre-ERP stock write-outs, value 0) is never a sale and is excluded. Amounts / margin
// are deliberately not part of this report (a separate amounts report is planned). Orders made in
// the app that the Excel does not hold yet (confirmed / packed / delivered, newer than the last ERP order day)
// are kept apart ("pending"), never added into the sold numbers, so nothing is counted twice.
import { pool } from "../db/pool.js";
import { yerevanToday } from "../utils/yerevanDate.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 300;
export const GROUP_BYS = ["product", "family", "brand", "grade", "size", "channel", "region", "subregion", "customer", "month", "week", "day"];

// --- date helpers (plain YYYY-MM-DD strings, UTC arithmetic, no timezone surprises) --------------------------
const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fmt(new Date(toUtc(s).getTime() + n * 86400000));
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const mondayOf = (s) => addDays(s, -((toUtc(s).getUTCDay() + 6) % 7));
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => fmt(new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)));
const addMonths = (s, n) => {
  const d = toUtc(monthStart(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fmt(d);
};
// The same calendar day n years earlier, clipped to the month's end (29 Feb -> 28 Feb).
const addYears = (s, n) => {
  const y = +s.slice(0, 4) + n;
  const lastDay = +monthEnd(`${y}-${s.slice(5, 7)}-01`).slice(8, 10);
  return `${y}-${s.slice(5, 7)}-${String(Math.min(+s.slice(8, 10), lastDay)).padStart(2, "0")}`;
};

// Every bucket key ("YYYY-MM-DD" for day / week-Monday, "YYYY-MM" for month) between two dates, so charts
// show empty days as zero instead of skipping them.
export function bucketKeys(from, to, bucket) {
  const keys = [];
  if (bucket === "month") {
    for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) keys.push(m.slice(0, 7));
  } else {
    const step = bucket === "week" ? 7 : 1;
    for (let d = bucket === "week" ? mondayOf(from) : from; d <= to; d = addDays(d, step)) keys.push(d);
  }
  return keys;
}

// The standard periods, each with the equivalent window just before it to compare with.
export function standardPeriods(today) {
  const mon = mondayOf(today);
  const lm = addMonths(today, -1);
  const dayOfMonth = +today.slice(8, 10);
  const lmSameDay = `${lm.slice(0, 7)}-${String(Math.min(dayOfMonth, +monthEnd(lm).slice(8, 10))).padStart(2, "0")}`;
  const y = +today.slice(0, 4);
  const qs = `${y}-${String(Math.floor((+today.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`; // this quarter's first day
  const lqs = addMonths(qs, -3);
  const lqe = monthEnd(addMonths(qs, -1));
  const minDate = (a, b) => (a < b ? a : b);
  return [
    { key: "today", from: today, to: today, prev: { from: addDays(today, -1), to: addDays(today, -1) } },
    { key: "yesterday", from: addDays(today, -1), to: addDays(today, -1), prev: { from: addDays(today, -2), to: addDays(today, -2) } },
    { key: "this_week", from: mon, to: today, prev: { from: addDays(mon, -7), to: addDays(today, -7) } },
    { key: "last_week", from: addDays(mon, -7), to: addDays(mon, -1), prev: { from: addDays(mon, -14), to: addDays(mon, -8) } },
    { key: "this_month", from: monthStart(today), to: today, prev: { from: monthStart(lm), to: lmSameDay } },
    { key: "last_month", from: monthStart(lm), to: monthEnd(lm), prev: { from: addMonths(lm, -1), to: monthEnd(addMonths(lm, -1)) } },
    // quarters (owner, 2026-10-22): this quarter so far against the same number of days of the previous one; last quarter whole
    { key: "this_quarter", from: qs, to: today, prev: { from: lqs, to: minDate(addDays(lqs, daysBetween(qs, today)), lqe) } },
    { key: "last_quarter", from: lqs, to: lqe, prev: { from: addMonths(lqs, -3), to: monthEnd(addMonths(lqs, -1)) } },
    { key: "ytd", from: `${y}-01-01`, to: today, prev: { from: `${y - 1}-01-01`, to: addYears(today, -1) } },
    { key: "last_year", from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, prev: { from: `${y - 2}-01-01`, to: `${y - 2}-12-31` } },
    { key: "last_12m", from: addDays(addYears(today, -1), 1), to: today, prev: { from: addDays(addYears(today, -2), 1), to: addYears(today, -1) } },
  ];
}

// Selected range + its comparison window.
export function resolveWindows(query, today = yerevanToday()) {
  const periods = standardPeriods(today);
  let from;
  let to;
  let period = String(query.period || "");
  if (DATE_RE.test(query.from || "") && DATE_RE.test(query.to || "")) {
    from = query.from;
    to = query.to;
    period = "custom";
  } else {
    const p = periods.find((x) => x.key === period) || periods.find((x) => x.key === "this_month");
    period = p.key;
    from = p.from;
    to = p.to;
  }
  if (from > to) [from, to] = [to, from];
  const compare = ["none", "prev", "yoy"].includes(query.compare) ? query.compare : "prev";
  let prev = null;
  if (compare === "yoy") prev = { from: addYears(from, -1), to: addYears(to, -1) };
  else if (compare === "prev") {
    const std = periods.find((x) => x.key === period);
    if (std) prev = std.prev; // "this month" compares with the same days of last month, not a longer span
    else {
      const len = daysBetween(from, to) + 1;
      prev = { from: addDays(from, -len), to: addDays(from, -1) };
    }
  }
  return { period, from, to, compare, prev, periods, today };
}

// --- filters ---------------------------------------------------------------------------------------------------
const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const SIZE_SQL = (col) =>
  `(CASE WHEN regexp_replace(trim(${col}), '[Ll]$', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN regexp_replace(trim(${col}), '[Ll]$', '')::numeric ELSE 0 END)`;

// Builds the WHERE for the filtered temp table from the query string. Returns { where, params }.
export function buildFilters(query) {
  const conds = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  for (const [param, col] of [["brands", "brand"], ["families", "family"], ["grades", "grade"], ["channels", "channel"], ["tiers", "tier"]]) {
    const values = list(query[param]);
    if (values.length) conds.push(`COALESCE(${col}, '—') = ANY(${add(values)}::text[])`);
  }
  const sizes = list(query.sizes).map(Number).filter((n) => Number.isFinite(n));
  if (sizes.length) conds.push(`size_n = ANY(${add(sizes)}::numeric[])`);
  const products = list(query.products).map((v) => v.toLowerCase());
  if (products.length) conds.push(`product_key = ANY(${add(products)}::text[])`);
  // "region::subregion" keys, as the shared region tree picker produces them ("__none__" = no subregion).
  const regionKeys = list(query.region_sub);
  if (regionKeys.length) {
    const parts = regionKeys.map((key) => {
      const [region, sub] = key.split("::");
      const r = `region = ${add(region)}`;
      if (!sub || sub === "__none__") return `(${r} AND COALESCE(subregion, '') = '')`;
      return `(${r} AND subregion = ${add(sub)})`;
    });
    conds.push(`(${parts.join(" OR ")})`);
  }
  // Product text: every term must match brand + name + size with all punctuation ignored ("5w30" finds "5W-30").
  for (const raw of String(query.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const squashed = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (squashed) conds.push(`lower(regexp_replace(concat_ws(' ', brand, product_label), '[^[:alnum:]]', '', 'g')) LIKE ${add(`%${squashed}%`)}`);
  }
  const cq = String(query.cq ?? "").trim();
  if (cq) {
    const p = add(`%${cq.replace(/[\\%_]/g, "\\$&")}%`);
    conds.push(`(customer_name ILIKE ${p} OR COALESCE(erp_customer_id, '') ILIKE ${p})`);
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

// --- group-by expressions -------------------------------------------------------------------------------------
const GROUP_SQL = {
  product: { key: "product_key", label: "product_label", sub: "MAX(brand)" },
  family: { key: "COALESCE(family, '—')", label: "COALESCE(family, '—')", sub: "MAX(brand)" },
  brand: { key: "COALESCE(brand, '—')", label: "COALESCE(brand, '—')", sub: "NULL" },
  grade: { key: "COALESCE(grade, '—')", label: "COALESCE(grade, '—')", sub: "NULL" },
  size: { key: "COALESCE(size_txt, '—')", label: "COALESCE(size_txt || ' L', '—')", sub: "NULL" },
  channel: { key: "COALESCE(channel, '—')", label: "COALESCE(channel, '—')", sub: "NULL" },
  region: { key: "COALESCE(region, '—')", label: "COALESCE(region, '—')", sub: "NULL" },
  subregion: { key: "COALESCE(region, '—') || '::' || COALESCE(NULLIF(subregion, ''), '__none__')", label: "COALESCE(NULLIF(subregion, ''), '—')", sub: "MAX(region)" },
  customer: { key: "cust_key", label: "customer_name", sub: "MAX(COALESCE(region, ''))" },
  month: { key: "to_char(d, 'YYYY-MM')", label: "to_char(d, 'YYYY-MM')", sub: "NULL" },
  week: { key: "to_char(date_trunc('week', d), 'YYYY-MM-DD')", label: "to_char(date_trunc('week', d), 'YYYY-MM-DD')", sub: "NULL" },
  day: { key: "to_char(d, 'YYYY-MM-DD')", label: "to_char(d, 'YYYY-MM-DD')", sub: "NULL" },
};
const TIME_GROUPS = new Set(["month", "week", "day"]);

const fillBuckets = (keys, rows) => {
  const by = new Map(rows.map((r) => [r.key, num(r.liters)]));
  return keys.map((key) => ({ key, liters: by.get(key) || 0 }));
};
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const aggs = (cond) => `
  COALESCE(sum(liters) FILTER (WHERE ${cond}), 0) AS liters,
  count(DISTINCT order_key) FILTER (WHERE ${cond}) AS orders,
  count(DISTINCT cust_key) FILTER (WHERE ${cond}) AS customers`;
const inWin = (w, src = "erp") => `src = '${src}' AND d BETWEEN '${w.from}' AND '${w.to}'`;
const shape = (r, prefix = "") => ({
  liters: num(r[`${prefix}liters`]),
  orders: num(r[`${prefix}orders`]),
  customers: num(r[`${prefix}customers`]),
});

// opts: { query, scopeUserId (sales manager: only their customers) }
export async function buildVolumeReport({ query, scopeUserId = null }) {
  const w = resolveWindows(query);
  const groupBy = GROUP_BYS.includes(query.group_by) ? query.group_by : "product";
  const winStart = [`${+w.today.slice(0, 4) - 2}-01-01`, w.from, w.prev?.from ?? w.from].sort()[0];
  const winEnd = [w.today, w.to].sort().pop();
  const { where, params: filterParams } = buildFilters(query);

  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");
    const scope = scopeUserId ? "AND c.assigned_manager_id = $3" : "";
    // Every line in the window, enriched once: product line/viscosity/size, selling channel, place, liters.
    await client.query(
      `CREATE TEMP TABLE vf ON COMMIT DROP AS
       WITH src AS (
         SELECT 'erp'::text AS src, eol.order_date AS d, 'e:' || eol.erp_customer_id || ':' || eol.order_id AS order_key,
                eol.erp_customer_id, c1.id AS cid,
                eol.brand, eol.product_name, eol.product_id, eol.size_l, eol.qty, eol.sales_rep AS line_channel
           FROM erp_order_lines eol
           LEFT JOIN customers c1 ON c1.erp_customer_id = eol.erp_customer_id
          WHERE eol.order_date BETWEEN $1 AND $2 AND eol.erp_customer_id <> '10000'
         UNION ALL
         SELECT 'app', (o.created_at AT TIME ZONE 'Asia/Yerevan')::date, 'a:' || o.id, c0.erp_customer_id, c0.id,
                oi.brand, oi.product_name, p0.erp_product_id, p0.unit, oi.quantity, NULL
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           JOIN customers c0 ON c0.id = o.customer_id
           LEFT JOIN products p0 ON p0.id = oi.product_id
          WHERE o.status IN ('confirmed', 'packed_stock_out', 'delivered')
            AND o.erp_matched_order_id IS NULL AND NOT COALESCE(o.delivered_from_erp, false)
            AND (o.created_at AT TIME ZONE 'Asia/Yerevan')::date > COALESCE((SELECT max(order_date) FROM erp_order_lines), DATE '1900-01-01')
            AND (o.created_at AT TIME ZONE 'Asia/Yerevan')::date BETWEEN $1 AND $2
       ), j AS (
         SELECT s.*, c.id AS c_id, c.name AS c_name, c.sales_channel, c.region, c.subregion, c.customer_tier,
                ecd.customer_name AS ecd_name, ecd.assigned_sales_rep, p.family,
                COALESCE(NULLIF(${SIZE_SQL("s.size_l")}, 0), ${SIZE_SQL("p.unit")}) AS size_n
           FROM src s
           LEFT JOIN customers c ON c.id = s.cid
           LEFT JOIN erp_customer_data ecd ON ecd.erp_customer_id = s.erp_customer_id
           LEFT JOIN products p ON lower(p.erp_product_id) = lower(s.product_id)
          WHERE TRUE ${scope}
       )
       SELECT j.src, j.d, j.order_key, j.erp_customer_id, j.brand, j.family, j.size_n,
              COALESCE(j.erp_customer_id, 'c' || j.c_id::text) AS cust_key,
              COALESCE(NULLIF(trim(j.c_name), ''), j.ecd_name, j.erp_customer_id, '—') AS customer_name,
              COALESCE(j.line_channel, j.assigned_sales_rep, j.sales_channel) AS channel,
              j.region, j.subregion, j.customer_tier AS tier,
              COALESCE(NULLIF(lower(trim(j.product_id)), ''), lower(concat_ws('', j.brand, j.product_name, j.size_l))) AS product_key,
              trim(concat_ws(' ', j.product_name, CASE WHEN j.size_n > 0 THEN j.size_n::float8::text || 'L' END)) AS product_label,
              regexp_replace(substring(j.product_name from '(\\d{1,2}\\s*[Ww]\\s*-?\\s*\\d{1,3})'), '\\s*[Ww]\\s*-?\\s*', 'W-') AS grade,
              NULLIF(j.size_n, 0)::float8::text AS size_txt,
              COALESCE(j.qty, 0) * j.size_n AS liters
         FROM j`,
      scopeUserId ? [winStart, winEnd, scopeUserId] : [winStart, winEnd]
    );
    await client.query(`CREATE TEMP TABLE vl ON COMMIT DROP AS SELECT * FROM vf ${where}`, filterParams);

    // 1) totals: selected window, comparison window, pending (app orders not in Excel), and every standard period.
    const winCols = [
      aggs(inWin(w)),
      ...(w.prev ? [aggs(inWin(w.prev)).replace(/AS (\w+)/g, "AS prev_$1")] : []),
      aggs(inWin(w, "app")).replace(/AS (\w+)/g, "AS pend_$1"),
      ...w.periods.map((p) => `COALESCE(sum(liters) FILTER (WHERE ${inWin(p)}), 0) AS p_${p.key}_liters,
        COALESCE(sum(liters) FILTER (WHERE ${inWin(p.prev)}), 0) AS p_${p.key}_prev_liters`),
    ];
    const { rows: totalRows } = await client.query(`SELECT ${winCols.join(",")} FROM vl`);
    const t = totalRows[0];
    const periodsOut = w.periods.map((p) => ({
      key: p.key,
      from: p.from,
      to: p.to,
      liters: num(t[`p_${p.key}_liters`]),
      prev_liters: num(t[`p_${p.key}_prev_liters`]),
    }));

    // 2) breakdown by the chosen dimension, with the comparison window beside it.
    const g = GROUP_SQL[groupBy];
    const order = TIME_GROUPS.has(groupBy) ? "key ASC" : "liters DESC, label ASC";
    const { rows: groupRows } = await client.query(
      `SELECT ${g.key} AS key, MAX(${g.label}) AS label, ${g.sub} AS sub,
              ${aggs(inWin(w))}${w.prev ? `,
              COALESCE(sum(liters) FILTER (WHERE ${inWin(w.prev)}), 0) AS prev_liters` : ""}
         FROM vl
        WHERE src = 'erp' AND d BETWEEN '${w.prev && w.prev.from < w.from ? w.prev.from : w.from}' AND '${w.prev && w.prev.to > w.to ? w.prev.to : w.to}'
        GROUP BY 1
       HAVING COALESCE(sum(liters) FILTER (WHERE ${inWin(w)}), 0) <> 0
        ORDER BY ${order}
        LIMIT ${MAX_ROWS}`
    );

    // 3) trend of the selected window (days up to ~5 weeks, weeks up to ~4 months, else months), zero-filled, with
    // the comparison window bucketed the same way so a chart can lay the two side by side by position.
    const span = daysBetween(w.from, w.to) + 1;
    const bucket = span <= 35 ? "day" : span <= 125 ? "week" : "month";
    const { rows: trendRows } = await client.query(
      `SELECT ${GROUP_SQL[bucket].key} AS key, COALESCE(sum(liters), 0) AS liters FROM vl WHERE ${inWin(w)} GROUP BY 1`
    );
    const prevTrendRows = w.prev
      ? (await client.query(`SELECT ${GROUP_SQL[bucket].key} AS key, COALESCE(sum(liters), 0) AS liters FROM vl WHERE ${inWin(w.prev)} GROUP BY 1`)).rows
      : [];
    // 3b) month by month, this year and last year (independent of the selected period, same filters).
    const year = +w.today.slice(0, 4);
    const { rows: monthlyRows } = await client.query(
      `SELECT to_char(d, 'YYYY-MM') AS key, COALESCE(sum(liters), 0) AS liters FROM vl
        WHERE src = 'erp' AND d BETWEEN '${year - 1}-01-01' AND '${w.today}' GROUP BY 1`
    );

    // 4) filter options: what really occurs in the last two years (independent of the current filters).
    const { rows: facetRows } = await client.query(
      `SELECT 'brand' AS kind, COALESCE(brand, '—') AS key, COALESCE(brand, '—') AS label, NULL AS parent, COALESCE(sum(liters), 0) AS liters FROM vf WHERE src = 'erp' GROUP BY 2, 3
       UNION ALL SELECT 'family', COALESCE(family, '—'), COALESCE(family, '—'), MAX(brand), COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' GROUP BY 2, 3
       UNION ALL SELECT 'grade', COALESCE(grade, '—'), COALESCE(grade, '—'), NULL, COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' GROUP BY 2, 3
       UNION ALL SELECT 'size', size_txt, size_txt || ' L', NULL, COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' AND size_n > 0 GROUP BY 2, 3
       UNION ALL SELECT 'channel', COALESCE(channel, '—'), COALESCE(channel, '—'), NULL, COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' GROUP BY 2, 3
       UNION ALL SELECT 'tier', COALESCE(tier, '—'), COALESCE(tier, '—'), NULL, COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' GROUP BY 2, 3
       UNION ALL SELECT 'product', product_key, MAX(product_label), MAX(COALESCE(brand, '—')) || '|' || COALESCE(MAX(family), '—'), COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' GROUP BY 2
       UNION ALL SELECT 'region', COALESCE(region, '') || '::' || COALESCE(NULLIF(subregion, ''), '__none__'), COALESCE(region, ''), COALESCE(subregion, ''), COALESCE(sum(liters), 0) FROM vf WHERE src = 'erp' AND region IS NOT NULL GROUP BY 2, 3, 4`
    );
    // All liters of the same window without any filter: "this selection is X% of everything sold".
    const { rows: allRows } = await client.query(
      `SELECT COALESCE(sum(liters) FILTER (WHERE ${inWin(w)}), 0) AS main${w.prev ? `, COALESCE(sum(liters) FILTER (WHERE ${inWin(w.prev)}), 0) AS prev` : ""} FROM vf`
    );
    const { rows: lastRows } = await client.query("SELECT max(order_date)::text AS last_order_date FROM erp_order_lines");
    await client.query("COMMIT");

    const facets = { brand: [], family: [], grade: [], size: [], channel: [], tier: [], product: [], region: [] };
    for (const r of facetRows) facets[r.kind].push({ key: r.key, label: r.label, parent: r.parent, liters: num(r.liters) });
    for (const k of Object.keys(facets)) facets[k].sort((a, b) => b.liters - a.liters);
    // Each pending/totals value in the unit the screen shows.
    const totals = shape(t);
    const out = {
      period: w.period,
      from: w.from,
      to: w.to,
      compare: w.compare,
      prev: w.prev,
      today: w.today,
      group_by: groupBy,
      last_erp_order_date: lastRows[0]?.last_order_date ?? null,
      totals: { ...totals, all_liters: num(allRows[0].main) },
      prev_totals: w.prev ? { ...shape(t, "prev_"), all_liters: num(allRows[0].prev) } : null,
      pending: shape(t, "pend_"),
      periods: periodsOut,
      rows: groupRows.map((r) => ({ key: r.key, label: r.label, sub: r.sub, ...shape(r), prev_liters: w.prev ? num(r.prev_liters) : null })),
      truncated: groupRows.length >= MAX_ROWS,
      trend: {
        bucket,
        rows: fillBuckets(bucketKeys(w.from, w.to, bucket), trendRows),
        prev_rows: w.prev ? fillBuckets(bucketKeys(w.prev.from, w.prev.to, bucket), prevTrendRows) : null,
      },
      monthly: { year, rows: fillBuckets(bucketKeys(`${year - 1}-01-01`, w.today, "month"), monthlyRows) },
      facets,
      standard_periods: w.periods.map((p) => ({ key: p.key, from: p.from, to: p.to })),
    };
    return out;
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release(releaseErr);
  }
}
