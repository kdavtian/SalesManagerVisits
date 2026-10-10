// Weekly debt digest (Monday 09:00+ Yerevan, once): how much the customers owe, how much of it is
// past due (FIFO invoice aging, see debtAging.js), what changed since last Monday and the biggest
// movers. Goes to the owner / CEO / sales director as an in-app + push notification and to the
// Telegram group. Each run stores a snapshot (debt_digest_snapshots) so the next one can compare.
import { pool } from "./db/pool.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { notifyUser } from "./notifications.js";
import { notifyTelegram, escapeHtml } from "./telegram.js";
import { AGING_BUCKETS, allocateFifo, loadOrdersNewestFirst } from "./debtAging.js";
import { cleanCustomerName } from "./orderBlankPdf.js";

const DIGEST_ROLES = ["admin", "ceo", "sales_director"];
const DIGEST_HOUR = 9;
const MOVERS = 5;

// Debt, overdue part and aging buckets of every customer that owes money right now.
export async function buildDebtSnapshot(db, today) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.erp_customer_id, COALESCE(c.credit_term_days, 45) AS term_days, erp.debt_amd
     FROM customers c JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE erp.debt_amd > 0`
  );
  const orders = await loadOrdersNewestFirst(db, rows.map((r) => r.erp_customer_id));
  const byBucket = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
  const customers = {};
  let total = 0;
  let overdue = 0;
  for (const r of rows) {
    const debt = Number(r.debt_amd);
    const alloc = allocateFifo({ orders: orders.get(r.erp_customer_id) ?? [], debt, today, termDays: Number(r.term_days) });
    for (const b of AGING_BUCKETS) byBucket[b] += alloc.buckets[b];
    total += debt;
    overdue += alloc.overdue_amd;
    customers[r.id] = { name: cleanCustomerName(r.name), debt: Math.round(debt), overdue: alloc.overdue_amd };
  }
  for (const b of AGING_BUCKETS) byBucket[b] = Math.round(byBucket[b]);
  return { total_debt_amd: Math.round(total), overdue_amd: Math.round(overdue), by_bucket: byBucket, customers };
}

// What changed against the previous snapshot (null = first digest: nothing to compare with).
export function compareSnapshots(current, previous) {
  const over90 = (s) => (s.by_bucket.d90_plus || 0) + (s.by_bucket.opening || 0);
  const out = {
    customers_overdue: Object.values(current.customers).filter((c) => c.overdue > 0).length,
    over90_amd: over90(current),
    delta_total: null,
    delta_overdue: null,
    movers: [],
  };
  if (!previous) return out;
  out.delta_total = current.total_debt_amd - Number(previous.total_debt_amd);
  out.delta_overdue = current.overdue_amd - Number(previous.overdue_amd);
  const ids = new Set([...Object.keys(current.customers), ...Object.keys(previous.customers)]);
  const movers = [];
  for (const id of ids) {
    const now = current.customers[id];
    const before = previous.customers[id];
    const delta = (now?.overdue ?? 0) - (before?.overdue ?? 0);
    if (Math.abs(delta) >= 1) movers.push({ name: (now ?? before).name, overdue: now?.overdue ?? 0, delta });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  out.movers = movers.slice(0, MOVERS);
  return out;
}

const amd = (n) => `${Math.round(n).toLocaleString("en-US")} դր`;
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${amd(Math.abs(n))}`;

// { title, push, telegram } -- Armenian text.
export function formatDigest(snapshot, cmp, today) {
  const [y, m, d] = today.split("-");
  const delta = (v) => (v === null ? "" : ` (${signed(v)})`);
  const title = "Շաբաթական պարտքի ամփոփում";
  const push = `Պարտք՝ ${amd(snapshot.total_debt_amd)}${delta(cmp.delta_total)} · ժամկետանց՝ ${amd(snapshot.overdue_amd)}${delta(cmp.delta_overdue)} · ${cmp.customers_overdue} հաճախորդ`;
  const lines = [
    `📊 <b>${title}</b> (${d}.${m}.${y})`,
    `Ընդհանուր պարտք՝ <b>${amd(snapshot.total_debt_amd)}</b>${delta(cmp.delta_total)}`,
    `Ժամկետանց՝ <b>${amd(snapshot.overdue_amd)}</b>${delta(cmp.delta_overdue)} · ${cmp.customers_overdue} հաճախորդ`,
    `90+ օր ուշացում (հին մնացորդով)՝ ${amd(cmp.over90_amd)}`,
  ];
  if (cmp.movers.length) {
    lines.push("", "Ամենամեծ փոփոխությունները (ժամկետանց)՝");
    for (const mv of cmp.movers) lines.push(`${mv.delta > 0 ? "🔺" : "🔻"} ${escapeHtml(mv.name)} — ${amd(mv.overdue)} (${signed(mv.delta)})`);
  } else if (cmp.delta_total === null) {
    lines.push("", "Սա առաջին ամփոփումն է. հաջորդ շաբաթվանից կցուցադրվեն փոփոխությունները։");
  }
  return { title, push, telegram: lines.join("\n") };
}

// Monday (Yerevan) from 09:00, once per Monday (the stored snapshot is the marker, so a restart
// does not send it twice). Returns the number of in-app notifications sent.
export async function sendWeeklyDebtDigest(now = new Date()) {
  const today = yerevanToday(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (dow !== 0) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < DIGEST_HOUR) return 0;
  const { rowCount: already } = await pool.query("SELECT 1 FROM debt_digest_snapshots WHERE snapshot_date = $1", [today]);
  if (already) return 0;

  const snapshot = await buildDebtSnapshot(pool, today);
  const { rows: prev } = await pool.query("SELECT * FROM debt_digest_snapshots WHERE snapshot_date < $1 ORDER BY snapshot_date DESC LIMIT 1", [today]);
  const { rowCount: stored } = await pool.query(
    `INSERT INTO debt_digest_snapshots (snapshot_date, total_debt_amd, overdue_amd, by_bucket, customers)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (snapshot_date) DO NOTHING`,
    [today, snapshot.total_debt_amd, snapshot.overdue_amd, JSON.stringify(snapshot.by_bucket), JSON.stringify(snapshot.customers)]
  );
  if (!stored) return 0; // another run got there first
  if (!snapshot.total_debt_amd) return 0; // no debt at all (empty data): nothing worth sending

  const text = formatDigest(snapshot, compareSnapshots(snapshot, prev[0] ?? null), today);
  const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DIGEST_ROLES]);
  for (const r of recipients) await notifyUser(r.id, "debt_digest", { title: text.title, body: text.push, url: "/#/reports?r=customer_debt" });
  notifyTelegram(text.telegram).catch(() => {});
  return recipients.length;
}
