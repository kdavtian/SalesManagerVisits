// Monthly fuel-allowance report: for every rep and every day, the distance
// driven between that day's check-ins (see fuelRoute.js), turned into litres
// and AMD with the rep's consumption and the month's fuel price.
import { pool } from "./db/pool.js";
import { yerevanCustomRangeBounds, yerevanDateOf } from "./utils/yerevanDate.js";
import { splitCheckins, buildWaypoints, routeKey, estimateLegsKm, requestRoute, routeState, fuelFor, round1 } from "./fuelRoute.js";

// How long one report request waits for missing road distances before it answers
// with estimates for the rest (they keep loading in the background).
let graceMs = 2500;
export function setRouteGraceMs(ms) {
  graceMs = ms;
}

export function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = `${month}-01`;
  const end = `${month}-${String(last).padStart(2, "0")}`;
  return { start, end, ...yerevanCustomRangeBounds(start, end) };
}

export const isMonth = (s) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export async function buildFuelReport({ month, userId = null }) {
  const { start, startAt, endAt } = monthBounds(month);
  const params = [startAt, endAt];
  let userFilter = "";
  if (userId) {
    params.push(userId);
    userFilter = ` AND ch.user_id = $3`;
  }

  const { rows: reps } = await pool.query(
    `SELECT id, name, name_hy, role, fuel_l_per_100km, home_address, home_lat, home_lng
     FROM users
     WHERE (role = 'sales_manager' OR id IN (SELECT user_id FROM checkins WHERE timestamp >= $1 AND timestamp < $2))
       ${userId ? "AND id = $3" : ""}
     ORDER BY name`,
    params
  );
  const { rows: checkins } = await pool.query(
    `SELECT ch.id, ch.user_id, ch.timestamp, ch.lat, ch.lng, ch.within_range, c.name AS customer_name, c.region
     FROM checkins ch JOIN customers c ON c.id = ch.customer_id
     WHERE ch.timestamp >= $1 AND ch.timestamp < $2${userFilter}
     ORDER BY ch.timestamp`,
    params
  );
  const { rows: priceRows } = await pool.query("SELECT price_amd_per_l FROM fuel_prices WHERE month = $1", [start]);
  const price = priceRows[0] ? Number(priceRows[0].price_amd_per_l) : null;
  const { rows: overrideRows } = await pool.query(
    "SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day, km, note FROM fuel_day_overrides WHERE day >= $1::date AND day <= ($1::date + interval '1 month' - interval '1 day')",
    [start]
  );
  const overrides = new Map(overrideRows.map((o) => [`${o.user_id}:${o.day}`, { km: Number(o.km), note: o.note }]));

  // user -> day -> check-ins
  const byUserDay = new Map();
  for (const c of checkins) {
    const day = yerevanDateOf(c.timestamp);
    const key = `${c.user_id}:${day}`;
    if (!byUserDay.has(key)) byUserDay.set(key, { userId: c.user_id, day, list: [] });
    byUserDay.get(key).list.push({ ...c, lat: Number(c.lat), lng: Number(c.lng) });
  }

  const repById = new Map(reps.map((r) => [r.id, r]));
  const dayJobs = [];
  for (const { userId: uid, day, list } of byUserDay.values()) {
    const rep = repById.get(uid);
    if (!rep) continue;
    const home = rep.home_lat != null && rep.home_lng != null ? { lat: Number(rep.home_lat), lng: Number(rep.home_lng), address: rep.home_address } : null;
    const { stops, skipped } = splitCheckins(list);
    const { points, missingHome } = buildWaypoints(stops, home);
    dayJobs.push({ rep, day, stops, skipped, points, missingHome, key: points.length > 1 ? routeKey(points) : null, legKm: null, source: "none", pending: false });
  }

  // Cached road distances first.
  const keys = dayJobs.map((j) => j.key).filter(Boolean);
  if (keys.length) {
    const { rows } = await pool.query("SELECT key, leg_km FROM fuel_route_cache WHERE key = ANY($1)", [keys]);
    const cached = new Map(rows.map((r) => [r.key, r.leg_km]));
    for (const j of dayJobs) {
      if (j.key && cached.has(j.key)) {
        j.legKm = cached.get(j.key).map(Number);
        j.source = "osrm";
      }
    }
  }
  // The rest from the routing engine in the background; wait only a moment.
  const missing = dayJobs.filter((j) => j.key && !j.legKm);
  const fetches = missing.map((j) =>
    requestRoute(j.key, j.points, async (res) => {
      await pool.query("INSERT INTO fuel_route_cache (key, leg_km, source) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING", [j.key, JSON.stringify(res.km), res.source]);
    }).then((km) => {
      if (km) {
        j.legKm = km;
        j.source = "osrm";
      }
    })
  );
  if (fetches.length) await Promise.race([Promise.allSettled(fetches), new Promise((resolve) => setTimeout(resolve, graceMs))]);
  const routing = { total: dayJobs.filter((j) => j.key).length, pending: 0, failed: 0 };
  for (const j of dayJobs) {
    if (j.points.length < 2) {
      j.legKm = [];
      j.source = "none";
    } else if (!j.legKm) {
      j.legKm = estimateLegsKm(j.points);
      j.source = "estimate";
      j.state = routeState(j.key) === "pending" ? "pending" : "failed";
      if (j.state === "pending") routing.pending++;
      else routing.failed++;
    }
  }

  // Assemble per rep.
  const out = reps.map((rep) => ({
    user_id: rep.id,
    name: rep.name,
    name_hy: rep.name_hy,
    fuel_l_per_100km: rep.fuel_l_per_100km != null ? Number(rep.fuel_l_per_100km) : null,
    home_address: rep.home_address,
    home_set: rep.home_lat != null && rep.home_lng != null,
    days: [],
    totals: { km: 0, liters: null, amount: null, days: 0, estimated_days: 0, missing_home_days: 0 },
  }));
  const outById = new Map(out.map((r) => [r.user_id, r]));

  for (const j of dayJobs) {
    const rep = outById.get(j.rep.id);
    const computed = round1(j.legKm.reduce((s, k) => s + k, 0));
    const override = overrides.get(`${j.rep.id}:${j.day}`) ?? null;
    const km = override ? override.km : computed;
    const fuel = fuelFor(km, rep.fuel_l_per_100km, price);
    const route = j.points.map((p, i) => ({
      type: p.type,
      back: Boolean(p.back),
      time: p.time ?? null,
      name: p.name,
      in_yerevan: p.inYerevan,
      lat: p.lat,
      lng: p.lng,
      km_from_prev: i === 0 ? null : round1(j.legKm[i - 1] ?? 0),
    }));
    // Stops merged into the previous one (same place) are listed for transparency.
    const merged = j.stops.flatMap((s) => s.merged.map((m) => ({ time: m.timestamp, name: m.customer_name })));
    rep.days.push({
      date: j.day,
      km,
      computed_km: computed,
      override,
      estimated: j.source === "estimate",
      estimate_state: j.source === "estimate" ? j.state : null,
      missing_home: j.missingHome,
      liters: fuel.liters,
      amount: fuel.amount,
      route,
      skipped: j.skipped.map((s) => ({ time: s.timestamp, name: s.customer_name, reason: s.reason })),
      merged,
    });
  }
  let pendingDays = 0;
  for (const rep of out) {
    rep.days.sort((a, b) => (a.date < b.date ? 1 : -1));
    rep.totals.days = rep.days.filter((d) => d.km > 0 || d.route.length).length;
    rep.totals.km = round1(rep.days.reduce((s, d) => s + d.km, 0));
    rep.totals.estimated_days = rep.days.filter((d) => d.estimated).length;
    rep.totals.missing_home_days = rep.days.filter((d) => d.missing_home).length;
    pendingDays += rep.totals.estimated_days;
    if (rep.fuel_l_per_100km != null) {
      rep.totals.liters = round1(rep.days.reduce((s, d) => s + (d.liters ?? 0), 0));
      rep.totals.amount = price != null ? rep.days.reduce((s, d) => s + (d.amount ?? 0), 0) : null;
    }
  }
  const sum = (f) => out.reduce((s, r) => s + (f(r) ?? 0), 0);
  return {
    month,
    price_amd_per_l: price,
    reps: out,
    totals: { km: round1(sum((r) => r.totals.km)), liters: round1(sum((r) => r.totals.liters)), amount: price != null ? sum((r) => r.totals.amount) : null },
    estimated_days: pendingDays,
    routing,
  };
}
