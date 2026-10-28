// Anti-fraud watch (owner, 2026-10-25: "there is a very high risk that sales reps collect cash and do not record it"). Vaghinak looks for
// the signs, management decides what each one was. Nothing here changes money or blocks a rep: it only raises findings (fraud_alerts),
// tells management, scores every rep and builds the weekly "call this customer and ask" list.
//
// The signals (owner's choice, 1-6):
//   payment_not_in_excel   a payment recorded in the app is still not in the Excel after N days (default 3)
//   cash_held_long / cash_held_amount   a rep has held unhanded cash for N days (3) or more than X AMD (1,000,000)
//   customer_dispute       a KAD OS customer pressed "I don't see my payments" (created in routes/partner.js)
//   cash_gap               a rep records far less cash than their cash-term deliveries suggest, next to the other reps
//   late_recorded / burst / repeated_amount   payments recorded days after the collection, many at once, the same round amount again and again
//   spot_check_mismatch    the weekly check call found that the customer says something different
// Every kind has a weight in the rep's risk score; "confirmed" / "false alarm" verdicts move the weight (he learns).
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { IN_EXCEL_SQL, DAYS_OLD_SQL, PAYMENT_DAY } from "./paymentExcelMatch.js";
import { bulletNames } from "../utils/bullets.js";
import { rolesWhere, seesFraudAlerts, editsFraudSettings } from "../shared/roles.js";

export const FRAUD_VIEW_ROLES = rolesWhere(seesFraudAlerts);
export const FRAUD_SETTINGS_ROLES = rolesWhere(editsFraudSettings);

export const FRAUD_DEFAULTS = {
  unmatchedDays: 3, // a payment recorded in the app and still missing from the Excel after this many days
  custodyDays: 3, // unhanded cash older than this
  custodyAmountAmd: 1000000, // or a rep holding more than this
  lateRecordedDays: 2, // collected more than this many days before it was recorded
  burstCount: 5, // this many payments recorded by one person ...
  burstMinutes: 10, // ... within this many minutes
  repeatedAmountCount: 4, // the same round amount (multiple of 50,000) this many times in 30 days, for 3+ customers
  gapMinExpectedAmd: 500000, // a rep needs at least this much cash-term delivery in the last 30 days to be compared
  gapPercentOfPeers: 50, // recorded share below this % of the median of the other reps is a finding
  spotChecksPerWeek: 5,
};
const NUMERIC_LIMITS = {
  unmatchedDays: [1, 60],
  custodyDays: [1, 60],
  custodyAmountAmd: [10000, 1000000000],
  lateRecordedDays: [1, 60],
  burstCount: [2, 50],
  burstMinutes: [1, 120],
  repeatedAmountCount: [2, 50],
  gapMinExpectedAmd: [0, 1000000000],
  gapPercentOfPeers: [5, 100],
  spotChecksPerWeek: [0, 30],
};

// How much one open finding of each kind adds to a rep's risk score (0-100) before the verdict-based learning.
export const DEFAULT_WEIGHTS = {
  customer_dispute: 40,
  spot_check_mismatch: 40,
  cash_gap: 25,
  cash_held_amount: 15,
  cash_held_long: 12,
  payment_not_in_excel: 10,
  burst: 8,
  repeated_amount: 6,
  late_recorded: 5,
};
export const FRAUD_KINDS = Object.keys(DEFAULT_WEIGHTS);
const RISK_WINDOW_DAYS = 60;

export async function getFraudSettings(db = pool) {
  const { rows } = await db.query("SELECT key, value FROM fraud_settings");
  const out = { ...FRAUD_DEFAULTS };
  for (const { key, value } of rows) if (key in FRAUD_DEFAULTS) out[key] = Number(value);
  return out;
}

export async function saveFraudSettings(patch, db = pool) {
  const clean = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in NUMERIC_LIMITS)) continue;
    const n = Number(value);
    const [lo, hi] = NUMERIC_LIMITS[key];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${key} must be between ${lo} and ${hi}`);
    clean[key] = Math.round(n);
  }
  for (const [key, value] of Object.entries(clean)) {
    await db.query(
      `INSERT INTO fraud_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  return clean;
}

export async function getWeights(db = pool) {
  const { rows } = await db.query("SELECT kind, weight, confirmed, false_alarms FROM fraud_signal_weights");
  const out = {};
  for (const kind of FRAUD_KINDS) out[kind] = { weight: DEFAULT_WEIGHTS[kind], default: DEFAULT_WEIGHTS[kind], confirmed: 0, false_alarms: 0 };
  for (const r of rows) if (out[r.kind]) out[r.kind] = { weight: Number(r.weight), default: DEFAULT_WEIGHTS[r.kind], confirmed: r.confirmed, false_alarms: r.false_alarms };
  return out;
}

// A verdict teaches him: "confirmed" makes this kind count 20 % more (at most 3x), "false alarm" 20 % less (at least a quarter).
export async function learnFromVerdict(kind, verdict, db = pool) {
  if (!(kind in DEFAULT_WEIGHTS) || !["confirmed", "false_alarm"].includes(verdict)) return;
  const base = DEFAULT_WEIGHTS[kind];
  const { rows } = await db.query("SELECT weight FROM fraud_signal_weights WHERE kind = $1", [kind]);
  const current = rows[0] ? Number(rows[0].weight) : base;
  const next = Math.min(base * 3, Math.max(base * 0.25, current * (verdict === "confirmed" ? 1.2 : 0.8)));
  await db.query(
    `INSERT INTO fraud_signal_weights (kind, weight, confirmed, false_alarms) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind) DO UPDATE SET weight = $2, confirmed = fraud_signal_weights.confirmed + $3, false_alarms = fraud_signal_weights.false_alarms + $4, updated_at = now()`,
    [kind, Math.round(next * 100) / 100, verdict === "confirmed" ? 1 : 0, verdict === "false_alarm" ? 1 : 0]
  );
}

// ---- risk score per rep ----
export function riskLevel(score) {
  return score >= 60 ? "high" : score >= 25 ? "medium" : "low";
}

export async function repRisk(db = pool) {
  const weights = await getWeights(db);
  const [{ rows: reps }, { rows: alerts }] = await Promise.all([
    db.query("SELECT id, COALESCE(name_hy, name) AS name FROM users WHERE role = 'sales_manager' AND status = 'active' ORDER BY name"),
    db.query(
      `SELECT rep_id, kind, severity, status FROM fraud_alerts
        WHERE rep_id IS NOT NULL AND status IN ('open', 'confirmed') AND created_at > now() - ($1 || ' days')::interval`,
      [RISK_WINDOW_DAYS]
    ),
  ]);
  return reps
    .map((r) => {
      const mine = alerts.filter((a) => a.rep_id === r.id);
      let raw = 0;
      const counts = {};
      for (const a of mine) {
        raw += (weights[a.kind]?.weight ?? 5) * (a.severity / 2) * (a.status === "confirmed" ? 1.5 : 1);
        counts[a.kind] = (counts[a.kind] ?? 0) + 1;
      }
      const score = Math.min(100, Math.round(raw));
      return { rep_id: r.id, name: r.name, score, level: riskLevel(score), open: mine.filter((a) => a.status === "open").length, counts };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ---- raising and clearing findings ----
async function raise(db, a) {
  const { rows } = await db.query(
    `INSERT INTO fraud_alerts (kind, severity, rep_id, customer_id, payment_id, amount_amd, details, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, amount_amd = EXCLUDED.amount_amd, details = EXCLUDED.details, updated_at = now()
       WHERE fraud_alerts.status = 'open'
     RETURNING id, (xmax = 0) AS inserted`,
    [a.kind, a.severity ?? 1, a.repId ?? null, a.customerId ?? null, a.paymentId ?? null, a.amount ?? null, JSON.stringify(a.details ?? {}), a.dedupeKey]
  );
  return rows[0]?.inserted ? rows[0].id : null;
}

// Findings of one kind that are no longer true (the payment reached the Excel, the cash was handed over) close themselves.
async function clearGone(db, kind, activeKeys) {
  await db.query(
    `UPDATE fraud_alerts SET status = 'auto_resolved', resolved_at = now(), updated_at = now()
      WHERE kind = $1 AND status = 'open' AND NOT (dedupe_key = ANY($2::text[]))`,
    [kind, activeKeys]
  );
}

const sevByAge = (days) => (days >= 14 ? 3 : days >= 7 ? 2 : 1);

// 1) recorded in the app, still not in the Excel
async function detectNotInExcel(db, s, created) {
  const { rows } = await db.query(
    `SELECT p.id, p.sales_manager_id AS rep_id, p.customer_id, p.amount_amd, ${DAYS_OLD_SQL}::int AS days,
            COALESCE(c.name, p.customer_name_snapshot) AS customer_name
       FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.status IN ('pending', 'approved') AND p.erp_customer_id_snapshot IS NOT NULL
        AND ${DAYS_OLD_SQL} >= $1 AND NOT ${IN_EXCEL_SQL} AND p.payment_date > now() - interval '120 days'`,
    [s.unmatchedDays]
  );
  const keys = [];
  for (const r of rows) {
    const key = `nie:${r.id}`;
    keys.push(key);
    const id = await raise(db, { kind: "payment_not_in_excel", severity: sevByAge(r.days), repId: r.rep_id, customerId: r.customer_id, paymentId: r.id, amount: r.amount_amd, details: { days: r.days, customer: r.customer_name }, dedupeKey: key });
    if (id) created.push({ id, kind: "payment_not_in_excel", customer: r.customer_name });
  }
  await clearGone(db, "payment_not_in_excel", keys);
}

// 2) cash held too long / too much
async function detectCustody(db, s, created) {
  const { rows } = await db.query(
    `SELECT p.current_holder_id AS holder_id, COALESCE(u.name_hy, u.name) AS holder_name,
            count(*)::int AS n, sum(p.amount_amd) AS total, max(${DAYS_OLD_SQL})::int AS oldest_days
       FROM payments p JOIN users u ON u.id = p.current_holder_id
      WHERE p.status = 'pending' AND p.pending_handoff_id IS NULL AND u.role IN ('sales_manager', 'sales_director') AND u.status = 'active'
      GROUP BY p.current_holder_id, u.name_hy, u.name`
  );
  const longKeys = [];
  const amountKeys = [];
  for (const r of rows) {
    const details = { days: r.oldest_days, count: r.n, total: Number(r.total), holder: r.holder_name };
    if (r.oldest_days >= s.custodyDays) {
      longKeys.push(`chl:${r.holder_id}`);
      const id = await raise(db, { kind: "cash_held_long", severity: r.oldest_days >= s.custodyDays * 2 ? 3 : 2, repId: r.holder_id, amount: r.total, details, dedupeKey: `chl:${r.holder_id}` });
      if (id) created.push({ id, kind: "cash_held_long", holderId: r.holder_id, ...details });
    }
    if (Number(r.total) >= s.custodyAmountAmd) {
      amountKeys.push(`cha:${r.holder_id}`);
      const id = await raise(db, { kind: "cash_held_amount", severity: Number(r.total) >= s.custodyAmountAmd * 2 ? 3 : 2, repId: r.holder_id, amount: r.total, details, dedupeKey: `cha:${r.holder_id}` });
      if (id) created.push({ id, kind: "cash_held_amount", holderId: r.holder_id, ...details });
    }
  }
  await clearGone(db, "cash_held_long", longKeys);
  await clearGone(db, "cash_held_amount", amountKeys);
}

// 4) cash-term deliveries vs the payments recorded for the same customers, next to the other reps
async function detectCashGap(db, s, created) {
  const { rows } = await db.query(
    `WITH win AS (
       SELECT o.customer_id, c.assigned_manager_id AS rep_id, o.total_amd
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.status = 'delivered' AND o.payment_term_days = 0 AND c.assigned_manager_id IS NOT NULL
          AND (SELECT max(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered')
              BETWEEN now() - interval '30 days' AND now() - interval '3 days'
     ), expected AS (SELECT rep_id, sum(total_amd) AS expected FROM win GROUP BY rep_id),
     recorded AS (
       SELECT rc.rep_id, COALESCE(sum(p.amount_amd), 0) AS recorded
         FROM (SELECT DISTINCT rep_id, customer_id FROM win) rc
         LEFT JOIN payments p ON p.customer_id = rc.customer_id AND p.status IN ('pending', 'approved') AND p.payment_date > now() - interval '33 days'
        GROUP BY rc.rep_id
     )
     SELECT e.rep_id, e.expected, r.recorded, COALESCE(u.name_hy, u.name) AS rep_name
       FROM expected e JOIN recorded r USING (rep_id) JOIN users u ON u.id = e.rep_id
      WHERE e.expected >= $1`,
    [s.gapMinExpectedAmd]
  );
  const keys = [];
  if (rows.length >= 2) {
    const ratios = rows.map((r) => Number(r.recorded) / Number(r.expected)).sort((a, b) => a - b);
    const median = ratios[Math.floor((ratios.length - 1) / 2)];
    // when nobody records much the app is simply not used for cash yet: no comparison
    if (median >= 0.2) {
      for (const r of rows) {
        const ratio = Number(r.recorded) / Number(r.expected);
        if (ratio < (median * s.gapPercentOfPeers) / 100) {
          const key = `gap:${r.rep_id}`;
          keys.push(key);
          const id = await raise(db, {
            kind: "cash_gap",
            severity: ratio < (median * s.gapPercentOfPeers) / 200 ? 3 : 2,
            repId: r.rep_id,
            amount: Number(r.expected) - Number(r.recorded),
            details: { expected: Number(r.expected), recorded: Number(r.recorded), percent: Math.round(ratio * 100), peers_percent: Math.round(median * 100), rep: r.rep_name },
            dedupeKey: key,
          });
          if (id) created.push({ id, kind: "cash_gap", rep: r.rep_name });
        }
      }
    }
  }
  await clearGone(db, "cash_gap", keys);
}

// 5) timing and pattern signals
async function detectPatterns(db, s, created) {
  const late = await db.query(
    `SELECT p.id, p.sales_manager_id AS rep_id, p.customer_id, p.amount_amd, ((p.created_at AT TIME ZONE 'Asia/Yerevan')::date - ${PAYMENT_DAY})::int AS late_days,
            COALESCE(c.name, p.customer_name_snapshot) AS customer_name
       FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.status <> 'rejected' AND p.created_at > now() - interval '30 days'
        AND (p.created_at AT TIME ZONE 'Asia/Yerevan')::date - ${PAYMENT_DAY} > $1`,
    [s.lateRecordedDays]
  );
  const lateKeys = [];
  for (const r of late.rows) {
    const key = `late:${r.id}`;
    lateKeys.push(key);
    const id = await raise(db, { kind: "late_recorded", severity: r.late_days >= 7 ? 2 : 1, repId: r.rep_id, customerId: r.customer_id, paymentId: r.id, amount: r.amount_amd, details: { late_days: r.late_days, customer: r.customer_name }, dedupeKey: key });
    if (id) created.push({ id, kind: "late_recorded", customer: r.customer_name });
  }
  await clearGone(db, "late_recorded", lateKeys);

  const burst = await db.query(
    `SELECT p1.created_by AS rep_id, ((p1.created_at AT TIME ZONE 'Asia/Yerevan')::date)::text AS day, count(*)::int AS n, sum(p2.amount_amd) AS total
       FROM payments p1 JOIN payments p2 ON p2.created_by = p1.created_by AND p2.created_at BETWEEN p1.created_at AND p1.created_at + ($2 || ' minutes')::interval
      WHERE p1.created_at > now() - interval '14 days' AND p1.status <> 'rejected' AND p2.status <> 'rejected'
      GROUP BY p1.id, p1.created_by, p1.created_at HAVING count(*) >= $1`,
    [s.burstCount, s.burstMinutes]
  );
  const burstKeys = [];
  const seen = new Set();
  for (const r of burst.rows) {
    const key = `burst:${r.rep_id}:${r.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    burstKeys.push(key);
    const id = await raise(db, { kind: "burst", severity: 1, repId: r.rep_id, amount: r.total, details: { count: r.n, minutes: s.burstMinutes, day: r.day }, dedupeKey: key });
    if (id) created.push({ id, kind: "burst", day: r.day });
  }
  await clearGone(db, "burst", burstKeys);

  const rep = await db.query(
    `SELECT sales_manager_id AS rep_id, amount_amd, count(*)::int AS n FROM payments
      WHERE status <> 'rejected' AND created_at > now() - interval '30 days' AND amount_amd >= 50000 AND amount_amd % 50000 = 0
      GROUP BY sales_manager_id, amount_amd HAVING count(*) >= $1 AND count(DISTINCT customer_id) >= 3`,
    [s.repeatedAmountCount]
  );
  const repKeys = [];
  for (const r of rep.rows) {
    const key = `rep:${r.rep_id}:${Number(r.amount_amd)}`;
    repKeys.push(key);
    const id = await raise(db, { kind: "repeated_amount", severity: 1, repId: r.rep_id, amount: r.amount_amd, details: { count: r.n, amount: Number(r.amount_amd) }, dedupeKey: key });
    if (id) created.push({ id, kind: "repeated_amount", amount: Number(r.amount_amd) });
  }
  await clearGone(db, "repeated_amount", repKeys);
}

// ---- the weekly "call and ask" list (6) ----
const weekStartOf = (dayStr) => {
  const d = new Date(`${dayStr}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};

export async function ensureWeeklySpotChecks(now = new Date(), db = pool) {
  const s = await getFraudSettings(db);
  const week = weekStartOf(yerevanToday(now));
  const { rows: have } = await db.query("SELECT count(*)::int AS n FROM fraud_spot_checks WHERE week_start = $1", [week]);
  const need = s.spotChecksPerWeek - have[0].n;
  if (need <= 0) return { week, created: 0 };
  const [{ rows: pool_ }, risk] = await Promise.all([
    db.query(
      `SELECT p.id, p.customer_id, p.sales_manager_id AS rep_id, p.amount_amd, ${PAYMENT_DAY}::text AS day,
              COALESCE(c.name, p.customer_name_snapshot) AS name, c.phone
         FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.status IN ('pending', 'approved') AND p.payment_date BETWEEN now() - interval '21 days' AND now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM fraud_spot_checks sc WHERE sc.payment_id = p.id OR (sc.customer_id = p.customer_id AND sc.week_start > $1::date - 28))
        ORDER BY random() LIMIT 300`,
      [week]
    ),
    repRisk(db),
  ]);
  const riskOf = new Map(risk.map((r) => [r.rep_id, r.score]));
  // random, but leaning toward reps with a higher risk score and bigger amounts
  const ranked = pool_
    .map((p) => ({ p, k: Math.random() * (1 + (riskOf.get(p.rep_id) ?? 0) / 50) * (1 + Math.min(5, Number(p.amount_amd) / 1000000)) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.p);
  const perRep = new Map();
  const customers = new Set();
  let created = 0;
  for (const p of ranked) {
    if (created >= need) break;
    if (customers.has(p.customer_id) || (perRep.get(p.rep_id) ?? 0) >= 2) continue;
    const { rowCount } = await db.query(
      `INSERT INTO fraud_spot_checks (week_start, payment_id, customer_id, rep_id, customer_name, customer_phone, amount_amd, payment_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (week_start, payment_id) DO NOTHING`,
      [week, p.id, p.customer_id, p.rep_id, p.name, p.phone, p.amount_amd, p.day]
    );
    if (rowCount) {
      created++;
      customers.add(p.customer_id);
      perRep.set(p.rep_id, (perRep.get(p.rep_id) ?? 0) + 1);
    }
  }
  return { week, created };
}

// A verdict on a check call: a mismatch becomes a (severe) finding about the rep.
export async function resolveSpotCheck(id, status, note, userId, db = pool) {
  if (!["confirmed", "mismatch", "no_answer"].includes(status)) throw new Error("status must be confirmed, mismatch or no_answer");
  const { rows } = await db.query(
    `UPDATE fraud_spot_checks SET status = $2, note = $3, checked_by = $4, checked_at = now() WHERE id = $1 RETURNING *`,
    [id, status, note ? String(note).slice(0, 300) : null, userId]
  );
  const row = rows[0];
  if (!row) return null;
  if (status === "mismatch") {
    await raise(db, {
      kind: "spot_check_mismatch", severity: 3, repId: row.rep_id, customerId: row.customer_id, paymentId: row.payment_id, amount: row.amount_amd,
      details: { customer: row.customer_name, note: row.note, payment_date: String(row.payment_date).slice(0, 10) }, dedupeKey: `scm:${row.id}`,
    });
  }
  return row;
}

// ---- the run ----
async function notifyFraudRoles(title, body) {
  const { rows } = await pool.query("SELECT id FROM users WHERE role = ANY($1) AND status = 'active'", [FRAUD_VIEW_ROLES]);
  for (const u of rows) await notifyUser(u.id, "fraud_alert", { title, body, url: "/#/vaghinak?tab=antifraud" }).catch((e) => console.error("Fraud notification failed:", e.message));
}

const KIND_TITLE_HY = {
  payment_not_in_excel: "վճարում՝ Excel-ում չկա",
  cash_held_long: "կանխիկը երկար է մնացել ձեռքին",
  cash_held_amount: "ձեռքին մեծ գումար կանխիկ",
  cash_gap: "գրանցված կանխիկը քիչ է",
  late_recorded: "վճարումը ուշ է գրանցվել",
  burst: "շատ վճարում՝ մի քանի րոպեում",
  repeated_amount: "նույն գումարը կրկին ու կրկին",
};

export async function runAntiFraud(now = new Date(), db = pool) {
  const s = await getFraudSettings(db);
  const created = [];
  await detectNotInExcel(db, s, created);
  await detectCustody(db, s, created);
  await detectCashGap(db, s, created);
  await detectPatterns(db, s, created);
  const checks = await ensureWeeklySpotChecks(now, db);
  if (created.length) {
    const byKind = new Map();
    for (const a of created) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    await notifyFraudRoles(
      `Հակաախարդախություն՝ ${created.length} նոր ազդանշան`,
      bulletNames([...byKind].map(([k, n]) => `${KIND_TITLE_HY[k] ?? k}՝ ${n}`), 4)
    );
    // the rep who holds the cash is told to hand it over (a plain reminder, not an accusation)
    for (const a of created.filter((x) => x.holderId)) {
      await notifyUser(a.holderId, "fraud_alert", {
        title: "Հանձնիր կանխիկը",
        body: `Քո մոտ ${Math.round(a.total).toLocaleString("en-US")} դր կանխիկ կա (${a.count} վճարում, ամենահինը՝ ${a.days} օր)։ Հանձնիր հաշվապահին։`,
        url: "/#/payments",
      }).catch(() => {});
    }
  }
  return { created: created.length, spotChecks: checks.created };
}

// The partner (KAD OS) customer pressed "I don't see my payments" -- management is told, the rep is NOT.
export async function recordCustomerDispute({ customerId, note }, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.assigned_manager_id AS rep_id, COALESCE(c.erp_customer_id, '') AS erp_id FROM customers c WHERE c.id = $1`,
    [customerId]
  );
  const c = rows[0];
  if (!c) return null;
  const day = yerevanToday();
  const id = await raise(db, {
    kind: "customer_dispute", severity: 3, repId: c.rep_id, customerId: c.id,
    details: { customer: c.name, erp_id: c.erp_id, note: note ? String(note).slice(0, 300) : null, day }, dedupeKey: `cd:${c.id}:${day}`,
  });
  if (id) await notifyFraudRoles("Հաճախորդը չի տեսնում իր վճարումները", `${c.name}${c.erp_id ? ` · ID ${c.erp_id}` : ""} — զանգահարիր հաճախորդին։`);
  return { id, customer: c.name };
}
