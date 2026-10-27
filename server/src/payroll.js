// Payroll rules (owner, 2026-10-23). Pure calculation in computeMonthPay; the loaders below feed it from the database.
//   pay = daily rate x paid days + commission + premiums + bonuses - deductions        (balance = pay - what Cashflow already paid)
//   daily rate = fixed salary / the month's working days (Mon-Sat, minus company holidays)
//   a day is PAID when: the boss marked it completed; or it is a day off inside the person's paid allowance; or nothing marks it and
//     - the person is visit-based and >= min % of that day's planned visits were done (company default 75 %), or
//     - the person is not visit-based (a normal working day), or the day has no approved visit plan (owner, 2026-10-23: a forgotten plan
//       is paid automatically; there is nothing to measure against);  a day marked unpaid, or a day off over the allowance, is not paid.
//       Today stays open until the % of an existing plan is reached.
//   commission = pct x (money collected | sales) of the person's channels, minus the excluded channels.
import { pool } from "./db/pool.js";
import { yerevanToday } from "./utils/yerevanDate.js";

export const STAFF_DEFAULTS = Object.freeze({ min_visit_pct: 75 });
export const MONTHS_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function normalizeStaffSettings(raw) {
  const s = { ...STAFF_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.min_visit_pct = Math.min(100, Math.max(1, Math.round(Number(s.min_visit_pct) || STAFF_DEFAULTS.min_visit_pct)));
  return s;
}

export async function getStaffSettings(db = pool) {
  const { rows } = await db.query("SELECT staff_settings FROM app_settings WHERE id = 1");
  return normalizeStaffSettings(rows[0]?.staff_settings);
}

export async function saveStaffSettings(patch, db = pool) {
  const next = normalizeStaffSettings({ ...(await getStaffSettings(db)), ...patch });
  await db.query(
    `INSERT INTO app_settings (id, staff_settings) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET staff_settings = EXCLUDED.staff_settings`,
    [JSON.stringify(next)]
  );
  return next;
}

// "YYYY-MM" -> { start: "YYYY-MM-01", end: "YYYY-MM-DD" (last day), days: ["YYYY-MM-01", ...] }
export function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const days = Array.from({ length: last }, (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, "0")}`);
  return { start: days[0], end: days[last - 1], days };
}

const isSunday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay() === 0;

// "SM YVN 2026 OCT" -> { key: "sm yvn", month: "2026-10" }; null when the text carries no month.
// The Excel rule is exactly "<Position> <YYYY> <MON>", but people type it many ways (owner, 2026-10-27: a salary paid to Martin showed in
// Cashflow and Staff said "nothing paid"). Accepted too: "SEP 2026", "September 2026", "2026-09", "09/2026", "SM YVN, 2026 SEP.", extra spaces.
const MONTH_WORDS = [
  ["jan", "january", "հունվար"], ["feb", "february", "փետրվար"], ["mar", "march", "մարտ"], ["apr", "april", "ապրիլ"],
  ["may", "մայիս"], ["jun", "june", "հունիս"], ["jul", "july", "հուլիս"], ["aug", "august", "օգոստոս"],
  ["sep", "sept", "september", "սեպտեմբեր"], ["oct", "october", "հոկտեմբեր"], ["nov", "november", "նոյեմբեր"], ["dec", "december", "դեկտեմբեր"],
];
const monthIndex = (word) => MONTH_WORDS.findIndex((w) => w.includes(word.toLowerCase().replace(/\.$/, "")));
const normKey = (x) => String(x ?? "").toLowerCase().replace(/[.,;:()_\-/]+/g, " ").replace(/\s+/g, " ").trim();

export function parseSalaryInfo(info) {
  const text = String(info ?? "").trim();
  const patterns = [
    [/(\d{4})\s*[-/. ]\s*([\p{L}]{3,10}\.?)\s*$/u, (m) => [m[1], monthIndex(m[2])]],
    [/([\p{L}]{3,10}\.?)\s*[-/. ,]\s*(\d{4})\s*\.?$/u, (m) => [m[2], monthIndex(m[1])]],
    [/(\d{4})[-/.](\d{1,2})\s*$/, (m) => [m[1], Number(m[2]) - 1]],
    [/(\d{1,2})[-/.](\d{4})\s*$/, (m) => [m[2], Number(m[1]) - 1]],
  ];
  for (const [re, pick] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const [year, mi] = pick(m);
    if (!(mi >= 0 && mi < 12)) continue;
    return { key: normKey(text.slice(0, m.index)), month: `${year}-${String(mi + 1).padStart(2, "0")}` };
  }
  return null;
}

// How strongly a payroll line's key names this person: 3 = their position or one of their pay keys, 2 = their full name, 1 = their first name
// or a text that contains their full name, 0 = not them.
export function salaryKeyMatches(key, staff) {
  return salaryMatchScore(key, staff) > 0;
}
function salaryMatchScore(key, staff) {
  const k = normKey(key);
  if (!k) return 0;
  const keys = new Set([staff.position, ...(staff.pay_keys ?? [])].map(normKey).filter(Boolean));
  if (keys.has(k)) return 3;
  const name = normKey(staff.name);
  if (!name) return 0;
  if (k === name) return 2;
  if (k === name.split(" ")[0] || ` ${k} `.includes(` ${name} `)) return 1;
  return 0;
}

// Every Salary row of the ledger with the month it pays (the month written in its Info, or -- when the Info has none -- the month it was paid
// in) and the ONE person it pays: the best match wins; a tie between two people (two Armens, a first name only) links nobody, so a payment
// is never counted twice -- it waits in the "not linked" list instead.
export async function salaryLines(db = pool) {
  const [{ rows }, { rows: staff }] = await Promise.all([
    db.query(
      `SELECT e.id, e.entry_date::text AS date, e.info, e.amount_amd::float8 AS amt, a.name AS account
       FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id LEFT JOIN cash_accounts a ON a.id = e.account_id
       WHERE lower(c.name) = 'salary'`
    ),
    db.query("SELECT id, name, position, pay_keys, active, start_date::text AS start_date, end_date::text AS end_date FROM staff_members"),
  ]);
  return rows.map((r) => {
    const p = parseSalaryInfo(r.info);
    const key = p ? p.key : normKey(r.info);
    let best = 0;
    let who = [];
    for (const s of staff) {
      const score = salaryMatchScore(key, s);
      if (score > best) [best, who] = [score, [s.id]];
      else if (score && score === best) who.push(s.id);
    }
    const month = p ? p.month : r.date.slice(0, 7);
    // A tie on the position ("SM YVN" when the old rep left and a new one took the job): the person who worked that month wins, then the
    // one still working here. Still a tie -> nobody.
    if (who.length > 1) {
      const byId = new Map(staff.map((s) => [s.id, s]));
      const narrow = (ids, keep) => {
        const kept = ids.filter((id) => keep(byId.get(id)));
        return kept.length ? kept : ids;
      };
      who = narrow(who, (s) => workedInMonth(s, month));
      if (who.length > 1) who = narrow(who, (s) => s.active);
    }
    return { ...r, key, month, month_from_date: !p, staff_id: who.length === 1 ? who[0] : null };
  });
}

function workedInMonth(s, month) {
  const first = `${month}-01`;
  const last = `${month}-31`; // compared as text: every real date of the month is <= "YYYY-MM-31"
  return (!s.start_date || s.start_date <= last) && (!s.end_date || s.end_date >= first);
}

// Salary rows of `month` that are linked to nobody: shown on Payroll so they can be linked to a person in one tap.
export async function unmatchedSalaryLines(month, db = pool, lines = null) {
  return (lines ?? (await salaryLines(db)))
    .filter((l) => l.month === month && l.staff_id === null)
    .map(({ id, date, info, amt, account, month_from_date }) => ({ id, date, info, amount_amd: -amt, account, month_from_date }));
}

/**
 * @param staff        a staff_members row
 * @param month        "YYYY-MM"
 * @param ctx          { today: "YYYY-MM-DD", holidays: Set, defaultMinPct, marks: Map(day -> status), visits: Map(day -> {planned, done}),
 *                       commissionBase: number, items: [{kind, amount_amd}], paid: number }
 */
export function computeMonthPay(staff, month, ctx) {
  const b = monthBounds(month);
  const fixed = Number(staff.fixed_salary_amd) || 0;
  const holidays = ctx.holidays ?? new Set();
  const workingSet = b.days.filter((d) => !isSunday(d) && !holidays.has(d));
  const W = workingSet.length;
  const dailyRate = W ? fixed / W : 0;
  const minPct = staff.min_visit_pct ?? ctx.defaultMinPct ?? STAFF_DEFAULTS.min_visit_pct;
  let dayoffsLeft = Number(staff.paid_dayoffs_per_month) || 0;
  const days = [];
  let paidDays = 0;
  let paidDaysToDate = 0;
  for (const d of b.days) {
    const working = !isSunday(d) && !holidays.has(d);
    const mark = ctx.marks?.get(d) ?? null;
    const outside = (staff.start_date && d < String(staff.start_date).slice(0, 10)) || (staff.end_date && d > String(staff.end_date).slice(0, 10));
    const v = ctx.visits?.get(d) ?? null;
    const pct = v && v.planned > 0 ? Math.round((v.done / v.planned) * 100) : null;
    let state;
    if (!working) state = "off"; // Sunday / holiday: not a working day, not in the basis
    else if (outside) state = "outside";
    else if (mark === "completed") state = "paid";
    else if (mark === "unpaid") state = "unpaid";
    else if (mark === "dayoff") {
      if (dayoffsLeft > 0) {
        dayoffsLeft--;
        state = "dayoff_paid";
      } else state = "dayoff_unpaid";
    } else if (d > ctx.today) state = "future";
    else if (!staff.visit_based) state = "paid";
    else if (!v || v.planned <= 0) state = "paid"; // no approved plan: paid automatically (owner's rule)
    else if (pct >= minPct) state = "paid";
    else state = d === ctx.today ? "future" : "unpaid"; // the day is not over yet
    const pays = state === "paid" || state === "dayoff_paid";
    if (pays) {
      paidDays++;
      if (d <= ctx.today) paidDaysToDate++;
    }
    days.push({ date: d, state, mark, planned: v?.planned ?? null, done: v?.done ?? null, pct });
  }
  const futureDays = days.filter((x) => x.state === "future").length;
  const round = (n) => Math.round(n);
  const dayPay = round(dailyRate * paidDays);
  const commissionBase = Number(ctx.commissionBase) || 0;
  const commission = staff.commission_basis !== "none" ? round((commissionBase * (Number(staff.commission_pct) || 0)) / 100) : 0;
  const sum = (kind) => (ctx.items ?? []).filter((i) => i.kind === kind).reduce((s, i) => s + Number(i.amount_amd), 0);
  const premiums = sum("premium");
  const bonuses = sum("bonus");
  const deductions = sum("deduction");
  const total = dayPay + commission + premiums + bonuses - deductions;
  const paid = Number(ctx.paid) || 0;
  return {
    month,
    working_days: W,
    daily_rate: round(dailyRate),
    paid_days: paidDays,
    future_days: futureDays,
    day_pay: dayPay,
    // what is already earned today, and what the month can still reach if every remaining day is paid
    day_pay_to_date: round(dailyRate * paidDaysToDate),
    day_pay_max: round(dailyRate * (paidDays + futureDays)),
    commission: { basis: staff.commission_basis, pct: Number(staff.commission_pct) || 0, base_amd: round(commissionBase), amount: commission },
    premiums,
    bonuses,
    deductions,
    total,
    paid,
    balance: total - paid,
    days,
  };
}

// ---- loaders ---------------------------------------------------------------------------------------------------------------

export async function holidaysOf(month, db = pool) {
  const b = monthBounds(month);
  const { rows } = await db.query("SELECT holiday_date::text AS d FROM company_holidays WHERE holiday_date BETWEEN $1 AND $2", [b.start, b.end]);
  return new Set(rows.map((r) => r.d));
}

// planned = customers of the person's approved visit plan of the day; done = how many of THEM got a rep check-in that day
export async function visitsOf(userId, month, db = pool) {
  const out = new Map();
  if (!userId) return out;
  const b = monthBounds(month);
  const { rows } = await db.query(
    `SELECT p.plan_date::text AS day, cardinality(p.customer_ids) AS planned,
            (SELECT COUNT(DISTINCT c.customer_id)::int FROM checkins c
              WHERE c.user_id = p.user_id AND c.customer_id = ANY(p.customer_ids)
                AND (c.timestamp AT TIME ZONE 'Asia/Yerevan')::date = p.plan_date) AS done
     FROM visit_plans p WHERE p.user_id = $1 AND p.status = 'approved' AND p.plan_date BETWEEN $2 AND $3`,
    [userId, b.start, b.end]
  );
  for (const r of rows) out.set(r.day, { planned: r.planned, done: r.done });
  return out;
}

// The commission base of one person for a month: money collected ("Oil order" cash in the ledger) or sales (order lines), by channel.
export async function commissionBaseOf(staff, month, db = pool) {
  if (staff.commission_basis === "none") return 0;
  const b = monthBounds(month);
  const channels = staff.commission_channels?.length ? staff.commission_channels.map((c) => c.toLowerCase()) : null;
  const excluded = (staff.commission_excluded ?? []).map((c) => c.toLowerCase());
  if (staff.commission_basis === "collected") {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(e.amount_amd), 0)::float8 AS base
       FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id
       WHERE lower(c.name) = 'oil order' AND e.entry_date BETWEEN $1 AND $2
         AND ($3::text[] IS NULL OR lower(e.sales_rep) = ANY($3))
         AND NOT (lower(COALESCE(e.sales_rep, '')) = ANY($4))`,
      [b.start, b.end, channels, excluded]
    );
    return rows[0].base;
  }
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.revenue_amd), 0)::float8 AS base
     FROM erp_order_lines l
     WHERE l.order_date BETWEEN $1 AND $2 AND l.erp_customer_id <> '10000'
       AND ($3::text[] IS NULL OR lower(l.sales_rep) = ANY($3))
       AND NOT (lower(COALESCE(l.sales_rep, '')) = ANY($4))`,
    [b.start, b.end, channels, excluded]
  );
  return rows[0].base;
}

// What Cashflow already paid this person for the month: Salary rows whose Info names the person (see parseSalaryInfo / salaryKeyMatches).
export async function paidOf(staff, month, db = pool, lines = null) {
  let paid = 0;
  let count = 0;
  for (const l of lines ?? (await salaryLines(db))) {
    if (l.month === month && l.staff_id === staff.id) {
      paid += -l.amt; // salary rows are negative (money out)
      count++;
    }
  }
  return { paid, count };
}

export async function marksOf(staffId, month, db = pool) {
  const b = monthBounds(month);
  const { rows } = await db.query("SELECT day::text AS day, status FROM staff_days WHERE staff_id = $1 AND day BETWEEN $2 AND $3", [staffId, b.start, b.end]);
  return new Map(rows.map((r) => [r.day, r.status]));
}

export async function itemsOf(staffId, month, db = pool) {
  const b = monthBounds(month);
  const { rows } = await db.query(
    "SELECT id, kind, amount_amd::float8 AS amount_amd, note, created_at FROM staff_pay_items WHERE staff_id = $1 AND month = $2 ORDER BY created_at, id",
    [staffId, b.start]
  );
  return rows;
}

export async function payForStaff(staff, month, { settings, holidays, today = yerevanToday(), db = pool, lines = null } = {}) {
  const [marks, visits, commissionBase, items, paid] = await Promise.all([
    marksOf(staff.id, month, db),
    staff.visit_based ? visitsOf(staff.user_id, month, db) : new Map(),
    commissionBaseOf(staff, month, db),
    itemsOf(staff.id, month, db),
    paidOf(staff, month, db, lines),
  ]);
  const pay = computeMonthPay(staff, month, {
    today,
    holidays: holidays ?? (await holidaysOf(month, db)),
    defaultMinPct: (settings ?? (await getStaffSettings(db))).min_visit_pct,
    marks,
    visits,
    commissionBase,
    items,
    paid: paid.paid,
  });
  return { ...pay, items, payments: paid.count };
}
