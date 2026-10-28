// Vaghinak looks at the money that goes OUT (owner, 2026-10-25: "he has to analyze expenses and give me reports, recommendations; weekly reports and live alerts").
// Source of truth = the Excel cashflow (cash_entries, categories of kind 'expense', outflows); the field reps' own "Cash expense" records
// (cash_expenses) must show up in the same Excel data, so every one of them is matched against it (same amount, within 5 days).
//   findings (live):   category_spike, big_entry, duplicate_entry, app_expense_not_in_excel, no_description, rep_cash_spike
//   weekly (Monday 09:00 Yerevan): one report -> management gets a push, the page shows it
//   recommendations:   plain rules over the numbers, shown on the Expenses tab (codes + figures, the client words them)
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { bullets } from "./utils/bullets.js";
import { rolesWhere, seesExpenseWatch } from "./roles.js";

export const EXPENSE_ROLES = rolesWhere(seesExpenseWatch);
const MATCH_DAYS = 5;
const SPIKE_FACTOR = 1.5;
const SPIKE_MIN_AMD = 300000;
const BIG_MIN_AMD = 500000;
const NO_DESC_MIN_AMD = 200000;
const REP_WEEK_MIN_AMD = 100000;

const monthStart = (day) => `${day.slice(0, 7)}-01`;
const addMonths = (day, n) => {
  const d = new Date(`${monthStart(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const daysInMonth = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

// All spend per month and category for the last 7 months (this one included), plus the sales of those months.
export async function expenseSummary(now = new Date(), db = pool) {
  const today = yerevanToday(now);
  const from = addMonths(today, -6);
  const [{ rows: spend }, { rows: sales }] = await Promise.all([
    db.query(
      `SELECT to_char(e.entry_date, 'YYYY-MM') AS m, c.name AS category, SUM(-e.amount_amd) AS spend, count(*)::int AS n
         FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
        WHERE c.kind = 'expense' AND e.entry_date >= $1::date AND e.entry_date <= $2::date
        GROUP BY 1, 2`,
      [from, today]
    ),
    db.query(
      `SELECT to_char(order_date, 'YYYY-MM') AS m, SUM(COALESCE(revenue_amd, 0)) AS sales
         FROM erp_order_lines WHERE order_date >= $1::date AND order_date <= $2::date GROUP BY 1`,
      [from, today]
    ),
  ]);
  const months = [];
  for (let i = -6; i <= 0; i++) months.push(addMonths(today, i).slice(0, 7));
  const cur = months[months.length - 1];
  const dom = +today.slice(8, 10);
  const factor = daysInMonth(today) / dom;
  const salesBy = new Map(sales.map((r) => [r.m, Number(r.sales)]));
  const byCat = new Map();
  for (const r of spend) {
    if (!byCat.has(r.category)) byCat.set(r.category, new Map());
    byCat.get(r.category).set(r.m, Number(r.spend));
  }
  const total = (m) => [...byCat.values()].reduce((n, mm) => n + (mm.get(m) ?? 0), 0);
  const prev3 = months.slice(-4, -1); // the three full months before this one
  const categories = [...byCat.entries()]
    .map(([name, mm]) => {
      const avg3 = prev3.reduce((n, m) => n + (mm.get(m) ?? 0), 0) / 3;
      const mtd = mm.get(cur) ?? 0;
      const projected = Math.round(mtd * factor);
      return { name, mtd, projected, last_month: mm.get(months[months.length - 2]) ?? 0, avg3: Math.round(avg3), change_pct: avg3 > 0 ? Math.round(((projected - avg3) / avg3) * 100) : null };
    })
    .sort((a, b) => b.projected - a.projected || b.mtd - a.mtd);
  const monthRows = months.map((m) => ({ month: m, spend: Math.round(total(m)), sales: Math.round(salesBy.get(m) ?? 0) }));
  const lastFull = monthRows[monthRows.length - 2];
  const avgShare = prev3.map((m) => ({ s: total(m), r: salesBy.get(m) ?? 0 })).filter((x) => x.r > 0);
  return {
    today,
    months: monthRows,
    this_month: { mtd: Math.round(total(cur)), projected: Math.round(total(cur) * factor), day: dom, days: daysInMonth(today) },
    last_month: lastFull,
    categories,
    spend_share_pct: lastFull.sales > 0 ? Math.round((lastFull.spend / lastFull.sales) * 100) : null,
    avg_spend_share_pct: avgShare.length ? Math.round((avgShare.reduce((n, x) => n + x.s, 0) / avgShare.reduce((n, x) => n + x.r, 0)) * 100) : null,
  };
}

// Plain rules over the summary: [{ code, ...figures }]. The client words them (en / hy).
export function recommendationsFor(summary, extra = {}) {
  const out = [];
  for (const c of summary.categories) {
    if (c.change_pct != null && c.change_pct >= 30 && c.projected - c.avg3 >= 200000 && summary.this_month.day >= 7) {
      out.push({ code: "category_up", category: c.name, pct: c.change_pct, projected: c.projected, avg3: c.avg3 });
    }
  }
  if (summary.spend_share_pct != null && summary.avg_spend_share_pct != null && summary.spend_share_pct >= summary.avg_spend_share_pct + 5) {
    out.push({ code: "share_up", pct: summary.spend_share_pct, avg: summary.avg_spend_share_pct });
  }
  const totalProjected = summary.categories.reduce((n, c) => n + c.projected, 0);
  const top = summary.categories[0];
  if (top && totalProjected > 0 && top.projected / totalProjected >= 0.5) out.push({ code: "concentration", category: top.name, pct: Math.round((top.projected / totalProjected) * 100) });
  if (extra.noDescription >= 3) out.push({ code: "describe", count: extra.noDescription });
  if (extra.appNotInExcel >= 1) out.push({ code: "app_not_in_excel", count: extra.appNotInExcel });
  return out;
}

async function raise(db, a) {
  const { rows } = await db.query(
    `INSERT INTO expense_alerts (kind, severity, category, amount_amd, details, dedupe_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, amount_amd = EXCLUDED.amount_amd, details = EXCLUDED.details, updated_at = now()
       WHERE expense_alerts.status = 'open'
     RETURNING id, (xmax = 0) AS inserted`,
    [a.kind, a.severity ?? 1, a.category ?? null, a.amount ?? null, JSON.stringify(a.details ?? {}), a.dedupeKey]
  );
  return rows[0]?.inserted ? rows[0].id : null;
}
async function clearGone(db, kind, keys) {
  await db.query(
    `UPDATE expense_alerts SET status = 'auto_resolved', resolved_at = now(), updated_at = now() WHERE kind = $1 AND status = 'open' AND NOT (dedupe_key = ANY($2::text[]))`,
    [kind, keys]
  );
}

// the same match everywhere: an Excel expense row of the same amount within 5 days
export const APP_EXPENSE_IN_EXCEL_SQL = `EXISTS (
  SELECT 1 FROM cash_entries x JOIN cash_categories k ON k.id = x.category_id
   WHERE k.kind = 'expense' AND ABS(x.amount_amd + ce.amount_amd) <= 1
     AND x.entry_date BETWEEN ((ce.created_at AT TIME ZONE 'Asia/Yerevan')::date) - ${MATCH_DAYS} AND ((ce.created_at AT TIME ZONE 'Asia/Yerevan')::date) + ${MATCH_DAYS})`;
export const APP_EXPENSE_DAYS_OLD_SQL = `((now() AT TIME ZONE 'Asia/Yerevan')::date - (ce.created_at AT TIME ZONE 'Asia/Yerevan')::date)`;

export async function runExpenseWatch(now = new Date(), db = pool) {
  const created = [];
  const summary = await expenseSummary(now, db);
  const monthKey = summary.today.slice(0, 7);

  // 1) a category on course to spend 1.5x its 3-month average
  const spikeKeys = [];
  if (summary.this_month.day >= 7) {
    for (const c of summary.categories) {
      if (c.avg3 > 0 && c.projected >= c.avg3 * SPIKE_FACTOR && c.projected - c.avg3 >= SPIKE_MIN_AMD) {
        const key = `spike:${c.name}:${monthKey}`;
        spikeKeys.push(key);
        const id = await raise(db, { kind: "category_spike", severity: c.projected >= c.avg3 * 2 ? 3 : 2, category: c.name, amount: c.projected - c.avg3, details: { projected: c.projected, avg3: c.avg3, pct: c.change_pct, mtd: c.mtd }, dedupeKey: key });
        if (id) created.push({ id, kind: "category_spike", category: c.name });
      }
    }
  }
  await clearGone(db, "category_spike", spikeKeys);

  // 2) an unusually large entry in the last 7 days (3x the category's usual, and at least 500,000)
  const recent = await db.query(
    `SELECT e.id, c.name AS category, -e.amount_amd AS spend, e.entry_date::text AS day, COALESCE(NULLIF(e.info, ''), NULLIF(e.ref, '')) AS note
       FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
      WHERE c.kind = 'expense' AND e.entry_date >= $1::date - 7 AND -e.amount_amd >= $2`,
    [summary.today, BIG_MIN_AMD]
  );
  const bigKeys = [];
  for (const r of recent.rows) {
    const { rows: hist } = await db.query(
      `SELECT -e.amount_amd AS spend FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
        WHERE c.name = $1 AND c.kind = 'expense' AND e.entry_date >= $2::date - 180 AND e.entry_date < $2::date - 7 AND e.amount_amd < 0`,
      [r.category, summary.today]
    );
    const usual = median(hist.map((h) => Number(h.spend)));
    if (usual > 0 && Number(r.spend) < usual * 3) continue;
    const key = `big:${r.id}`;
    bigKeys.push(key);
    const id = await raise(db, { kind: "big_entry", severity: 2, category: r.category, amount: r.spend, details: { day: r.day, note: r.note, usual }, dedupeKey: key });
    if (id) created.push({ id, kind: "big_entry", category: r.category, amount: Number(r.spend) });
  }
  await clearGone(db, "big_entry", bigKeys);

  // 3) the same amount in the same category twice within 2 days
  const dups = await db.query(
    `SELECT least(a.id, b.id) AS lo, greatest(a.id, b.id) AS hi, c.name AS category, -a.amount_amd AS spend, a.entry_date::text AS day
       FROM cash_entries a JOIN cash_entries b ON b.id > a.id AND b.category_id = a.category_id AND b.amount_amd = a.amount_amd AND ABS(b.entry_date - a.entry_date) <= 2
       JOIN cash_categories c ON c.id = a.category_id
      WHERE c.kind = 'expense' AND a.amount_amd < 0 AND -a.amount_amd >= 50000 AND a.entry_date >= $1::date - 30`,
    [summary.today]
  );
  const dupKeys = [];
  for (const r of dups.rows) {
    const key = `dup:${r.lo}:${r.hi}`;
    dupKeys.push(key);
    const id = await raise(db, { kind: "duplicate_entry", severity: 1, category: r.category, amount: r.spend, details: { day: r.day }, dedupeKey: key });
    if (id) created.push({ id, kind: "duplicate_entry", category: r.category, amount: Number(r.spend) });
  }
  await clearGone(db, "duplicate_entry", dupKeys);

  // 4) a field cash expense recorded in the app that the Excel does not show after 5 days
  const missing = await db.query(
    `SELECT ce.id, ce.amount_amd, ce.purpose, COALESCE(u.name_hy, u.name) AS rep, ${APP_EXPENSE_DAYS_OLD_SQL}::int AS days
       FROM cash_expenses ce JOIN users u ON u.id = ce.user_id
      WHERE ${APP_EXPENSE_DAYS_OLD_SQL} >= ${MATCH_DAYS} AND ce.created_at > now() - interval '120 days' AND NOT ${APP_EXPENSE_IN_EXCEL_SQL}`
  );
  const missKeys = [];
  for (const r of missing.rows) {
    const key = `ace:${r.id}`;
    missKeys.push(key);
    const id = await raise(db, { kind: "app_expense_not_in_excel", severity: r.days >= 14 ? 2 : 1, amount: r.amount_amd, details: { rep: r.rep, purpose: r.purpose, days: r.days }, dedupeKey: key });
    if (id) created.push({ id, kind: "app_expense_not_in_excel", amount: Number(r.amount_amd) });
  }
  await clearGone(db, "app_expense_not_in_excel", missKeys);

  // 5) a big expense row with no description
  const nodesc = await db.query(
    `SELECT e.id, c.name AS category, -e.amount_amd AS spend, e.entry_date::text AS day
       FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
      WHERE c.kind = 'expense' AND e.amount_amd < 0 AND -e.amount_amd >= $2 AND e.entry_date >= $1::date - 14
        AND COALESCE(NULLIF(trim(e.info), ''), NULLIF(trim(e.ref), '')) IS NULL`,
    [summary.today, NO_DESC_MIN_AMD]
  );
  const noKeys = [];
  for (const r of nodesc.rows) {
    const key = `nodesc:${r.id}`;
    noKeys.push(key);
    const id = await raise(db, { kind: "no_description", severity: 1, category: r.category, amount: r.spend, details: { day: r.day }, dedupeKey: key });
    if (id) created.push({ id, kind: "no_description", category: r.category, amount: Number(r.spend) });
  }
  await clearGone(db, "no_description", noKeys);

  // 6) a rep's cash expenses this week at 3x their usual week
  const reps = await db.query(
    `WITH w AS (
       SELECT ce.user_id, date_trunc('week', ce.created_at AT TIME ZONE 'Asia/Yerevan')::date AS wk, SUM(ce.amount_amd) AS spend
         FROM cash_expenses ce WHERE ce.created_at > now() - interval '60 days' GROUP BY 1, 2
     ) SELECT cur.user_id, cur.wk::text AS wk, cur.spend, COALESCE(u.name_hy, u.name) AS rep,
              (SELECT COALESCE(avg(p.spend), 0) FROM w p WHERE p.user_id = cur.user_id AND p.wk < cur.wk) AS usual
         FROM w cur JOIN users u ON u.id = cur.user_id
        WHERE cur.wk = date_trunc('week', now() AT TIME ZONE 'Asia/Yerevan')::date`
  );
  const repKeys = [];
  for (const r of reps.rows) {
    if (Number(r.spend) >= REP_WEEK_MIN_AMD && Number(r.usual) > 0 && Number(r.spend) >= Number(r.usual) * 3) {
      const key = `rep:${r.user_id}:${r.wk}`;
      repKeys.push(key);
      const id = await raise(db, { kind: "rep_cash_spike", severity: 2, amount: r.spend, details: { rep: r.rep, usual: Math.round(Number(r.usual)) }, dedupeKey: key });
      if (id) created.push({ id, kind: "rep_cash_spike", rep: r.rep });
    }
  }
  await clearGone(db, "rep_cash_spike", repKeys);

  if (created.length) await notifyExpenseRoles("Ծախսերի ազդանշան՝ " + created.length, bullets(created.slice(0, 4).map(labelOf)));
  const weekly = await maybeWeeklyReport(now, db, summary);
  return { created: created.length, weekly };
}

const KIND_HY = {
  category_spike: "կատեգորիայի ծախսը աճում է",
  big_entry: "անսովոր մեծ ծախս",
  duplicate_entry: "կրկնվող ծախս",
  app_expense_not_in_excel: "դաշտային ծախսը Excel-ում չկա",
  no_description: "մեծ ծախս՝ առանց նկարագրի",
  rep_cash_spike: "ներկայացուցչի կանխիկ ծախսը շատ է",
};
const amdHy = (n) => `${Math.round(Number(n)).toLocaleString("en-US")} դր`;
const labelOf = (a) => `${KIND_HY[a.kind] ?? a.kind}${a.category ? ` · ${a.category}` : ""}${a.amount ? ` · ${amdHy(a.amount)}` : ""}`;

async function notifyExpenseRoles(title, body) {
  const { rows } = await pool.query("SELECT id FROM users WHERE role = ANY($1) AND status = 'active'", [EXPENSE_ROLES]);
  for (const u of rows) await notifyUser(u.id, "expense_alert", { title, body, url: "/#/vaghinak?tab=expenses" }).catch((e) => console.error("Expense notification failed:", e.message));
}

// Monday from 09:00 Yerevan: last week's spending in a few lines
const weekStartOf = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
async function maybeWeeklyReport(now, db, summary) {
  const hourYerevan = (now.getUTCHours() + 4) % 24;
  const thisWeek = weekStartOf(summary.today);
  if (hourYerevan < 9) return false;
  const { rows: have } = await db.query("SELECT 1 FROM expense_reports WHERE week_start = $1", [thisWeek]);
  if (have.length) return false;
  const lastWeek = new Date(`${thisWeek}T00:00:00Z`);
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
  const lw = lastWeek.toISOString().slice(0, 10);
  const prev = new Date(lastWeek);
  prev.setUTCDate(prev.getUTCDate() - 7);
  const pw = prev.toISOString().slice(0, 10);
  const sum = async (a, b) =>
    (await db.query(
      `SELECT c.name AS category, SUM(-e.amount_amd) AS spend FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
        WHERE c.kind = 'expense' AND e.entry_date >= $1::date AND e.entry_date < $2::date GROUP BY 1 ORDER BY 2 DESC`,
      [a, b]
    )).rows.map((r) => ({ category: r.category, spend: Number(r.spend) }));
  const [last, before] = [await sum(lw, thisWeek), await sum(pw, lw)];
  const totalLast = last.reduce((n, r) => n + r.spend, 0);
  const totalBefore = before.reduce((n, r) => n + r.spend, 0);
  const open = (await db.query("SELECT count(*)::int AS n FROM expense_alerts WHERE status = 'open'")).rows[0].n;
  const rec = recommendationsFor(summary);
  const report = { week_start: lw, total: Math.round(totalLast), previous: Math.round(totalBefore), top: last.slice(0, 3), open_alerts: open, recommendations: rec.slice(0, 3) };
  const { rowCount } = await db.query("INSERT INTO expense_reports (week_start, summary) VALUES ($1, $2::jsonb) ON CONFLICT (week_start) DO NOTHING", [thisWeek, JSON.stringify(report)]);
  if (!rowCount) return false;
  const delta = totalBefore > 0 ? Math.round(((totalLast - totalBefore) / totalBefore) * 100) : null;
  await notifyExpenseRoles(
    "Շաբաթվա ծախսերը",
    bullets([
      `Անցած շաբաթ՝ ${amdHy(totalLast)}${delta == null ? "" : ` (${delta >= 0 ? "+" : ""}${delta}% նախորդ շաբաթվա նկատմամբ)`}`,
      ...last.slice(0, 3).map((r) => `${r.category}՝ ${amdHy(r.spend)}`),
      open ? `Բաց ազդանշաններ՝ ${open}` : null,
    ])
  );
  return true;
}

export async function expenseOverview(now = new Date(), db = pool) {
  const summary = await expenseSummary(now, db);
  const [alerts, reports, noDesc, appMissing, cashByRep] = await Promise.all([
    db.query(`SELECT id, kind, severity, category, amount_amd, details, created_at FROM expense_alerts WHERE status = 'open' ORDER BY severity DESC, created_at DESC LIMIT 100`),
    db.query("SELECT week_start::text AS week_start, summary, created_at FROM expense_reports ORDER BY week_start DESC LIMIT 4"),
    db.query(`SELECT count(*)::int AS n FROM expense_alerts WHERE status = 'open' AND kind = 'no_description'`),
    db.query(`SELECT count(*)::int AS n FROM expense_alerts WHERE status = 'open' AND kind = 'app_expense_not_in_excel'`),
    db.query(
      `SELECT COALESCE(u.name_hy, u.name) AS rep, SUM(ce.amount_amd) AS spend, count(*)::int AS n,
              count(*) FILTER (WHERE NOT ${APP_EXPENSE_IN_EXCEL_SQL} AND ${APP_EXPENSE_DAYS_OLD_SQL} >= ${MATCH_DAYS})::int AS not_in_excel
         FROM cash_expenses ce JOIN users u ON u.id = ce.user_id
        WHERE ce.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') GROUP BY 1 ORDER BY 2 DESC LIMIT 15`
    ),
  ]);
  return {
    ...summary,
    alerts: alerts.rows,
    reports: reports.rows,
    recommendations: recommendationsFor(summary, { noDescription: noDesc.rows[0].n, appNotInExcel: appMissing.rows[0].n }),
    cash_by_rep: cashByRep.rows.map((r) => ({ ...r, spend: Number(r.spend) })),
  };
}
