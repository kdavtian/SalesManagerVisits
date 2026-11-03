// Usage analytics (owner, 2026-11-03): which screens are opened, how long they stay open and which menu buttons are tapped. A switch in the admin
// Settings (app_settings.usage_analytics_enabled, OFF by default). Only the screen's kind is stored ("#/customers/:id", never the id, never a
// search text), the person's role and the time; the report shows totals and the number of different people, not who.
import { pool } from "../db/pool.js";

export const MAX_BATCH = 200;
export const MAX_SECONDS = 1800; // one screen is never counted for more than half an hour (a phone left open)
const RETENTION_DAYS = 90;

export async function getUsageEnabled(db = pool) {
  const { rows } = await db.query("SELECT usage_analytics_enabled FROM app_settings WHERE id = 1");
  return rows[0]?.usage_analytics_enabled ?? false;
}

export async function setUsageEnabled(enabled, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO app_settings (id, usage_analytics_enabled) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET usage_analytics_enabled = EXCLUDED.usage_analytics_enabled RETURNING usage_analytics_enabled`,
    [enabled]
  );
  return rows[0].usage_analytics_enabled;
}

// "#/customers/123?x=1" -> "#/customers/:id"; anything that is not a plain app address is dropped
export function pageKey(raw) {
  const s = String(raw ?? "").split("?")[0].trim();
  if (!/^#\/[A-Za-z0-9/_-]{0,80}$/.test(s)) return null;
  return s.replace(/\/\d+(?=\/|$)/g, "/:id");
}

const tapKey = (raw) => (/^[A-Za-z0-9_:#/-]{1,60}$/.test(String(raw ?? "")) ? String(raw) : null);

/** events: [{ kind: 'page', target, seconds } | { kind: 'tap', target }] -> rows stored. */
export async function recordEvents(user, events, db = pool) {
  const rows = [];
  for (const e of (Array.isArray(events) ? events : []).slice(0, MAX_BATCH)) {
    if (e?.kind === "page") {
      const target = pageKey(e.target);
      const seconds = Math.round(Number(e.seconds));
      if (target && Number.isFinite(seconds) && seconds >= 1) rows.push(["page", target, Math.min(seconds, MAX_SECONDS)]);
    } else if (e?.kind === "tap") {
      const target = tapKey(e.target);
      if (target) rows.push(["tap", target, null]);
    }
  }
  if (!rows.length) return 0;
  await db.query(
    `INSERT INTO usage_events (user_id, role, kind, target, seconds)
     SELECT $1, $2, k, t, s FROM unnest($3::text[], $4::text[], $5::int[]) AS x(k, t, s)`,
    [user.id, user.role, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])]
  );
  return rows.length;
}

/** The admin's report over the last `days` days: pages (visits, time, people) and taps (count, people). */
export async function usageReport(days, db = pool) {
  const span = Math.min(365, Math.max(1, Math.round(Number(days) || 30)));
  const [{ rows: pages }, { rows: taps }, { rows: [total] }] = await Promise.all([
    db.query(
      `SELECT target, count(*)::int AS visits, COALESCE(sum(seconds), 0)::int AS total_seconds, round(avg(seconds))::int AS avg_seconds, count(DISTINCT user_id)::int AS people
       FROM usage_events WHERE kind = 'page' AND at > now() - make_interval(days => $1) GROUP BY target ORDER BY total_seconds DESC LIMIT 60`,
      [span]
    ),
    db.query(
      `SELECT target, count(*)::int AS taps, count(DISTINCT user_id)::int AS people
       FROM usage_events WHERE kind = 'tap' AND at > now() - make_interval(days => $1) GROUP BY target ORDER BY taps DESC LIMIT 40`,
      [span]
    ),
    db.query("SELECT count(DISTINCT user_id)::int AS people, count(*)::int AS events, min(at) AS since FROM usage_events WHERE at > now() - make_interval(days => $1)", [span]),
  ]);
  return { days: span, pages, taps, people: total.people, events: total.events, since: total.since };
}

export async function deleteOldUsage(db = pool) {
  const { rowCount } = await db.query("DELETE FROM usage_events WHERE at < now() - make_interval(days => $1)", [RETENTION_DAYS]);
  return { deleted: rowCount };
}
