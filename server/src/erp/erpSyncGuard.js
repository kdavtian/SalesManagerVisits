// The "big drop" guard (improvement plan 0.5, owner 2026-11-28). Every Excel sync wipes and reloads the customers' debt, the order history and
// the cash lines, and the credit-limit check reads that debt (orders/creditLimit.js). An empty or half-saved workbook used to wipe all debts,
// so every credit check passed until the next good file. Now, before anything is changed, the incoming counts are compared with the last
// good sync: when one of them falls by more than MAX_DROP (and the old count was meaningful, more than MIN_PREVIOUS), the sync is refused
// with 422, nothing changes, and admin / CEO / operations director are told (app notification + the Telegram alert chats).
// A real change gets through with `force: true` in the bot's payload, or with the admin's "Accept the next sync" button in System health:
// it lets ONE sync of each kind (main sync, Cashflow push of the same file) through within ACCEPT_HOURS, then it is used up, so a second bad
// file in the same window is refused again. Every big drop let through is recorded as a warning attempt (who / how).
// Rules only here; the routes call checkSyncDrop() / refuseDrop().
import { pool } from "../db/pool.js";
import { recordSyncAttempt } from "./erpSyncAttempts.js";
import { notifyTelegram, escapeHtml } from "../shared/telegram.js";

export const MAX_DROP = 0.2; // more than 20 % fewer rows than last time
export const MIN_PREVIOUS = 50; // ... and only when last time had more than 50 (a tiny table can halve for real)
export const ACCEPT_HOURS = 2;

// Plain words for the owner (Telegram, System health) and for the bot's log.
export const COUNT_LABELS = {
  customers: { hy: "հաճախորդներ", en: "customers" },
  customers_with_debt: { hy: "պարտք ունեցող հաճախորդներ", en: "customers with debt" },
  order_lines: { hy: "պատվերի տողեր", en: "order lines" },
  cashflow_lines: { hy: "վճարման տողեր", en: "payment lines" },
  products: { hy: "ապրանքներ", en: "products" },
  ledger_rows: { hy: "Cashflow թերթի տողեր", en: "Cashflow sheet rows" },
};

// Pure: which counts fell too far. `incoming` / `previous` map a key to a number (null / undefined = not sent / not known: never compared).
export function findDrops(incoming, previous, { maxDrop = MAX_DROP, minPrevious = MIN_PREVIOUS } = {}) {
  const drops = [];
  for (const [key, now] of Object.entries(incoming ?? {})) {
    const before = previous?.[key];
    if (!Number.isFinite(now) || !Number.isFinite(before)) continue;
    if (before <= minPrevious) continue;
    if (now < before * (1 - maxDrop)) drops.push({ key, before, now, drop_pct: Math.round((1 - now / before) * 100) });
  }
  return drops;
}

export function describeDrops(drops, lang = "en") {
  return drops.map((d) => `${COUNT_LABELS[d.key]?.[lang] ?? d.key}: ${d.before} → ${d.now} (−${d.drop_pct}%)`).join(", ");
}

export const GUARDED_COUNTS = ["customers", "customers_with_debt", "order_lines", "cashflow_lines", "products"];

// The last good main-sync counts, key by key: the newest run that carried each count (a run without order lines says nothing about them),
// however many runs ago (erp_sync_runs keeps 60 days).
export async function lastGoodCounts(db = pool) {
  const { rows } = await db.query(
    `SELECT k AS key,
            (SELECT (r.counts->>k)::float8 FROM erp_sync_runs r WHERE jsonb_typeof(r.counts->k) = 'number' ORDER BY r.at DESC, r.id DESC LIMIT 1) AS value
       FROM unnest($1::text[]) AS k`,
    [GUARDED_COUNTS]
  );
  const out = {};
  for (const { key, value } of rows) if (Number.isFinite(value)) out[key] = value;
  return out;
}

export const MAIN = "/api/erp-sync";
export const LEDGER = "/api/erp-sync/cashflow-ledger";

// The guard's state for System health. `refusals`: the last refusal of each kind of sync that is still open (no good sync of the SAME kind since:
// the main sync by erp_sync_runs, the Cashflow push by the bot's cash_syncs row), each with `accepted` = the admin's accept is still unused for
// that kind. Kept per kind, so a refusal of one never hides or closes the other's.
export async function getSyncGuard(db = pool) {
  const { rows } = await db.query(
    `SELECT s.erp_sync_refusals AS refusals, s.erp_sync_accept_until AS accept_until, s.erp_sync_accept_used AS accept_used, u.name AS accept_by_name,
            (SELECT MAX(at) FROM erp_sync_runs) AS main_ok_at, (SELECT MAX(at) FROM cash_syncs WHERE via = 'bot') AS ledger_ok_at
       FROM app_settings s LEFT JOIN users u ON u.id = s.erp_sync_accept_by WHERE s.id = 1`
  );
  const r = rows[0] ?? {};
  const used = r.accept_used ?? [];
  const windowOpen = Boolean(r.accept_until && new Date(r.accept_until).getTime() > Date.now());
  const acceptFor = (endpoint) => windowOpen && !used.includes(endpoint);
  const okAt = { [MAIN]: r.main_ok_at, [LEDGER]: r.ledger_ok_at };
  const refusals = [];
  for (const endpoint of [MAIN, LEDGER]) {
    const ref = r.refusals?.[endpoint];
    if (!ref?.at) continue;
    if (okAt[endpoint] && new Date(okAt[endpoint]) >= new Date(ref.at)) continue;
    refusals.push({ endpoint, at: ref.at, reason: ref.reason ?? null, accepted: acceptFor(endpoint) });
  }
  return {
    refusals,
    refused_open: refusals.length > 0,
    accept_until: windowOpen && (acceptFor(MAIN) || acceptFor(LEDGER)) ? r.accept_until : null,
    accept_used: windowOpen ? used : [],
    accept_by_name: windowOpen ? (r.accept_by_name ?? null) : null,
  };
}

// The admin's "Accept the next sync": within ACCEPT_HOURS, one sync of each kind goes through even with a big drop (a new tap re-opens both).
export async function acceptNextSync(userId, db = pool) {
  await db.query(
    `INSERT INTO app_settings (id, erp_sync_accept_until, erp_sync_accept_by, erp_sync_accept_used) VALUES (1, now() + make_interval(hours => $2), $1, '{}')
     ON CONFLICT (id) DO UPDATE SET erp_sync_accept_until = EXCLUDED.erp_sync_accept_until, erp_sync_accept_by = EXCLUDED.erp_sync_accept_by, erp_sync_accept_used = '{}'`,
    [userId ?? null, ACCEPT_HOURS]
  );
  return getSyncGuard(db);
}

// The decision for one sync of `endpoint` (MAIN or LEDGER). `previous` is read by the caller (main sync: lastGoodCounts; ledger: the rows in
// the app now). Returns { ok: true, drops, overridden } or { ok: false, drops, reason }. A drop let through is recorded (warning attempt), and
// an admin's accept is used up for this endpoint (atomically: two syncs at once cannot both use it).
export async function checkSyncDrop({ endpoint, incoming, previous, force = false, db = pool }) {
  const drops = findDrops(incoming, previous);
  if (!drops.length) return { ok: true, drops, overridden: false };
  let overridden = null;
  if (force === true) overridden = "the bot's force flag";
  else {
    const { rows } = await db.query(
      `UPDATE app_settings s SET erp_sync_accept_used = array_append(s.erp_sync_accept_used, $1::text)
        WHERE s.id = 1 AND s.erp_sync_accept_until > now() AND NOT ($1::text = ANY(s.erp_sync_accept_used))
        RETURNING (SELECT name FROM users WHERE id = s.erp_sync_accept_by) AS by_name`,
      [endpoint]
    );
    if (rows[0]) overridden = `accepted by ${rows[0].by_name ?? "an admin"}`;
  }
  if (!overridden) return { ok: false, drops, reason: `Big drop against the last good sync, nothing was changed: ${describeDrops(drops)}` };
  await recordSyncAttempt({ endpoint, ok: true, warnings: [`Big drop let through (${overridden}): ${describeDrops(drops)}`] });
  return { ok: true, drops, overridden };
}

// Records a refused sync and tells management; answers the bot with 422. Best effort around the answer: never throws.
const telegramSent = new Map(); // reason -> last time; one Telegram message per distinct reason per 6 hours (the bot may retry)
export async function refuseDrop(res, { endpoint, check }) {
  try {
    const entry = JSON.stringify({ [endpoint]: { at: new Date().toISOString(), reason: check.reason.slice(0, 2000) } });
    await pool.query(
      `INSERT INTO app_settings (id, erp_sync_refusals) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET erp_sync_refusals = app_settings.erp_sync_refusals || EXCLUDED.erp_sync_refusals`,
      [entry]
    );
  } catch (err) {
    console.error("erp sync guard: could not save the refusal:", err.message);
  }
  await recordSyncAttempt({ endpoint, ok: false, error: check.reason });
  const hy = describeDrops(check.drops, "hy");
  const SIX_HOURS = 6 * 3600 * 1000;
  if (Date.now() - (telegramSent.get(hy) ?? 0) > SIX_HOURS) {
    for (const [k, at] of telegramSent) if (Date.now() - at > SIX_HOURS) telegramSent.delete(k);
    telegramSent.set(hy, Date.now());
    notifyTelegram(
      `⚠️ <b>Excel-ի համաժամացումը մերժվեց</b>\nՖայլում տվյալները կտրուկ պակասել են՝ ${escapeHtml(hy)}։\nԱպում ոչինչ չի փոխվել (պարտքերը մնացել են նախորդ ֆայլից)։\nԵթե փոփոխությունը իրական է՝ Համակարգի վիճակ → «Ընդունել հաջորդ համաժամացումը»։`
    ).catch(() => {});
  }
  return res.status(422).json({ error: check.reason, code: "sync_drop_refused", drops: check.drops });
}
