// The "big drop" guard (improvement plan 0.5, owner 2026-11-28). Every Excel sync wipes and reloads the customers' debt, the order history and
// the cash lines, and the credit-limit check reads that debt (orders/creditLimit.js). An empty or half-saved workbook used to wipe all debts,
// so every credit check passed until the next good file. Now, before anything is changed, the incoming counts are compared with the last
// good sync: when one of them falls by more than MAX_DROP (and the old count was meaningful, more than MIN_PREVIOUS), the sync is refused
// with 422, nothing changes, and admin / CEO / operations director are told (app notification + the Telegram alert chats).
// A real change gets through with `force: true` in the bot's payload, or with the admin's one-time "Accept the next sync" button in System
// health (open for ACCEPT_HOURS). Rules only here; the routes call checkSyncDrop() / refuseDrop().
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

// The last good main-sync counts, key by key: the newest run that carried each count (a run without order lines says nothing about them).
export async function lastGoodCounts(db = pool) {
  const { rows } = await db.query("SELECT counts FROM erp_sync_runs ORDER BY at DESC, id DESC LIMIT 30");
  const out = {};
  for (const { counts } of rows) {
    for (const [key, value] of Object.entries(counts ?? {})) {
      if (out[key] === undefined && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

export async function getSyncGuard(db = pool) {
  const { rows } = await db.query(
    `SELECT s.erp_sync_refused_at AS refused_at, s.erp_sync_refused_reason AS refused_reason, s.erp_sync_accept_until AS accept_until, u.name AS accept_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.erp_sync_accept_by WHERE s.id = 1`
  );
  const r = rows[0] ?? {};
  const acceptOpen = Boolean(r.accept_until && new Date(r.accept_until).getTime() > Date.now());
  return {
    refused_at: r.refused_at ?? null,
    refused_reason: r.refused_reason ?? null,
    accept_until: acceptOpen ? r.accept_until : null,
    accept_by_name: acceptOpen ? (r.accept_by_name ?? null) : null,
  };
}

// The admin's "Accept the next sync": the next syncs within ACCEPT_HOURS go through even with a big drop.
export async function acceptNextSync(userId, db = pool) {
  await db.query(
    `INSERT INTO app_settings (id, erp_sync_accept_until, erp_sync_accept_by) VALUES (1, now() + make_interval(hours => $2), $1)
     ON CONFLICT (id) DO UPDATE SET erp_sync_accept_until = EXCLUDED.erp_sync_accept_until, erp_sync_accept_by = EXCLUDED.erp_sync_accept_by`,
    [userId ?? null, ACCEPT_HOURS]
  );
  return getSyncGuard(db);
}

// The decision for one sync. `previous` is read by the caller (main sync: lastGoodCounts; ledger: the rows in the app now).
// Returns { ok: true, drops, overridden } or { ok: false, drops, reason }.
export async function checkSyncDrop({ incoming, previous, force = false, db = pool }) {
  const drops = findDrops(incoming, previous);
  if (!drops.length) return { ok: true, drops, overridden: false };
  if (force === true) return { ok: true, drops, overridden: "force" };
  const guard = await getSyncGuard(db);
  if (guard.accept_until) return { ok: true, drops, overridden: "accepted" };
  return { ok: false, drops, reason: `Big drop against the last good sync, nothing was changed: ${describeDrops(drops)}` };
}

// Records a refused sync and tells management; answers the bot with 422. Best effort around the answer: never throws.
const telegramSent = new Map(); // reason -> last time; one Telegram message per distinct reason per 6 hours (the bot may retry)
export async function refuseDrop(res, { endpoint, check }) {
  try {
    await pool.query(
      `INSERT INTO app_settings (id, erp_sync_refused_at, erp_sync_refused_reason) VALUES (1, now(), $1)
       ON CONFLICT (id) DO UPDATE SET erp_sync_refused_at = now(), erp_sync_refused_reason = EXCLUDED.erp_sync_refused_reason`,
      [check.reason.slice(0, 2000)]
    );
  } catch (err) {
    console.error("erp sync guard: could not save the refusal:", err.message);
  }
  await recordSyncAttempt({ endpoint, ok: false, error: check.reason });
  const hy = describeDrops(check.drops, "hy");
  if (Date.now() - (telegramSent.get(hy) ?? 0) > 6 * 3600 * 1000) {
    telegramSent.set(hy, Date.now());
    notifyTelegram(
      `⚠️ <b>Excel-ի համաժամացումը մերժվեց</b>\nՖայլում տվյալները կտրուկ պակասել են՝ ${escapeHtml(hy)}։\nԱպում ոչինչ չի փոխվել (պարտքերը մնացել են նախորդ ֆայլից)։\nԵթե փոփոխությունը իրական է՝ Համակարգի վիճակ → «Ընդունել հաջորդ համաժամացումը»։`
    ).catch(() => {});
  }
  return res.status(422).json({ error: check.reason, code: "sync_drop_refused", drops: check.drops });
}
