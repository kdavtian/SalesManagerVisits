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

export async function getSyncGuard(db = pool) {
  const { rows } = await db.query(
    `SELECT s.erp_sync_refused_at AS refused_at, s.erp_sync_refused_reason AS refused_reason, s.erp_sync_refused_endpoint AS refused_endpoint,
            s.erp_sync_accept_until AS accept_until, s.erp_sync_accept_used AS accept_used, u.name AS accept_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.erp_sync_accept_by WHERE s.id = 1`
  );
  const r = rows[0] ?? {};
  const used = r.accept_used ?? [];
  // open while the time lasts and not both kinds of sync have used it
  const acceptOpen = Boolean(r.accept_until && new Date(r.accept_until).getTime() > Date.now() && !(used.includes(MAIN) && used.includes(LEDGER)));
  return {
    refused_at: r.refused_at ?? null,
    refused_reason: r.refused_reason ?? null,
    refused_endpoint: r.refused_endpoint ?? null,
    accept_until: acceptOpen ? r.accept_until : null,
    accept_used: acceptOpen ? used : [],
    accept_by_name: acceptOpen ? (r.accept_by_name ?? null) : null,
  };
}

// Is the last refusal still open? Closed by a later good sync of the SAME kind: the main sync by erp_sync_runs, the Cashflow push by the
// bot's cash_syncs row (a good main sync does not fix a refused Cashflow sheet).
export async function refusalOpen(guard, db = pool) {
  if (!guard.refused_at) return false;
  const sql =
    guard.refused_endpoint === LEDGER
      ? "SELECT MAX(at) AS at FROM cash_syncs WHERE via = 'bot'"
      : "SELECT MAX(at) AS at FROM erp_sync_runs";
  const { rows } = await db.query(sql);
  return !rows[0]?.at || new Date(guard.refused_at) > new Date(rows[0].at);
}

// The admin's "Accept the next sync": the next syncs within ACCEPT_HOURS go through even with a big drop.
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
    await pool.query(
      `INSERT INTO app_settings (id, erp_sync_refused_at, erp_sync_refused_reason, erp_sync_refused_endpoint) VALUES (1, now(), $1, $2)
       ON CONFLICT (id) DO UPDATE SET erp_sync_refused_at = now(), erp_sync_refused_reason = EXCLUDED.erp_sync_refused_reason,
         erp_sync_refused_endpoint = EXCLUDED.erp_sync_refused_endpoint`,
      [check.reason.slice(0, 2000), endpoint]
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
