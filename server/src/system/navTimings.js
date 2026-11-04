// Tap-to-screen timings from the real phones (owner, 2026-11-04: "measure every tap"). The app sends batches made by the shared KAD kit
// (client/public/js/kit/navTiming.js); this file checks and stores them and builds the "Slowest screens" table of the usage report.
// Nothing private: a route is a screen's kind ("#/customers/:id"), plus the role and the kind of device.
import { pool } from "../db/pool.js";

export const MAX_BATCH = 40;
export const MAX_MS = 15000;
const RETENTION_DAYS = 30;
const DEVICES = new Set(["phone", "tablet", "desktop"]);

// "#/customers/123?x=1" -> "#/customers/:id"; anything that is not a plain app address is dropped
export function routeKey(raw) {
  const s = String(raw ?? "").split("?")[0].trim();
  if (!/^#\/[A-Za-z0-9/:_-]{0,80}$/.test(s)) return null;
  return s.replace(/\/\d+(?=\/|$)/g, "/:id");
}

/** items: [{ route, ms, kind: 'nav' | 'inp' }] -> the rows that pass the checks (at most MAX_BATCH). */
export function cleanTimings(items) {
  const rows = [];
  for (const e of (Array.isArray(items) ? items : []).slice(0, MAX_BATCH)) {
    const route = routeKey(e?.route);
    const ms = Math.round(Number(e?.ms));
    const kind = e?.kind === "inp" ? "inp" : e?.kind === "nav" ? "nav" : null;
    if (route && kind && Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS) rows.push({ route, ms, kind });
  }
  return rows;
}

export async function recordNavTimings(user, items, device, db = pool) {
  const rows = cleanTimings(items);
  if (!rows.length) return 0;
  const dev = DEVICES.has(device) ? device : "phone";
  await db.query(
    `INSERT INTO nav_timings (route, ms, kind, role, device)
     SELECT r, m, k, $1, $2 FROM unnest($3::text[], $4::int[], $5::text[]) AS x(r, m, k)`,
    [user.role, dev, rows.map((r) => r.route), rows.map((r) => r.ms), rows.map((r) => r.kind)]
  );
  return rows.length;
}

/** The slowest screens of the last `days` days: tap-to-screen p50 / p75 / p95 and how many samples, slowest p75 first. */
export async function slowestScreens(days = 7, db = pool) {
  const span = Math.min(30, Math.max(1, Math.round(Number(days) || 7)));
  const { rows } = await db.query(
    `SELECT route,
            count(*)::int AS samples,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS p50,
            round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ms))::int AS p75,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int AS p95,
            count(*) FILTER (WHERE device = 'phone')::int AS phone_samples
       FROM nav_timings
      WHERE kind = 'nav' AND at > now() - make_interval(days => $1)
      GROUP BY route
     HAVING count(*) >= 3
      ORDER BY p75 DESC
      LIMIT 15`,
    [span]
  );
  const { rows: slowTaps } = await db.query(
    `SELECT route, count(*)::int AS samples, round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ms))::int AS p75
       FROM nav_timings WHERE kind = 'inp' AND at > now() - make_interval(days => $1)
      GROUP BY route ORDER BY samples DESC LIMIT 10`,
    [span]
  );
  return { days: span, screens: rows, slowTaps };
}

export async function deleteOldNavTimings(db = pool) {
  const { rowCount } = await db.query("DELETE FROM nav_timings WHERE at < now() - make_interval(days => $1)", [RETENTION_DAYS]);
  return { deleted: rowCount };
}
