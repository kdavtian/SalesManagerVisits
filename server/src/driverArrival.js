// Driver arrival (owner, 2026-10-23): the driver's phone reports where it is; when it stays within `radius_m` of a customer on today's route for
// `dwell_seconds`, the app either offers a one-tap "Delivered" (mode "suggest") or marks that customer's orders Delivered itself (mode "auto").
// Admin picks the mode in App configuration -> Delivery. Mode "off" = nothing is detected and nothing is stored.
import { pool } from "./db/pool.js";
import { haversineMeters, creditedDistanceMeters } from "./utils/geo.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { moveOrdersToDelivered, notifyCheckinDelivered } from "./checkinDelivery.js";

export const ARRIVAL_MODES = ["off", "suggest", "auto"];
export const ARRIVAL_DEFAULTS = Object.freeze({ mode: "suggest", radius_m: 80, dwell_seconds: 45 });
// A fix coarser than this says nothing about which house the driver is at.
export const ARRIVAL_MAX_ACCURACY_M = 150;
// Leaving the circle by more than this resets the "arrived" clock (a drive-by that did not stop).
const LEAVE_MARGIN_M = 60;

export function normalizeArrivalSettings(raw) {
  const s = { ...ARRIVAL_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!ARRIVAL_MODES.includes(s.mode)) s.mode = ARRIVAL_DEFAULTS.mode;
  return s;
}

export function validateArrivalPatch(patch) {
  const out = {};
  if (patch.mode !== undefined) {
    if (!ARRIVAL_MODES.includes(patch.mode)) return { error: "mode must be off, suggest or auto" };
    out.mode = patch.mode;
  }
  for (const [k, min, max] of [["radius_m", 20, 500], ["dwell_seconds", 0, 600]]) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${k} must be a whole number between ${min} and ${max}` };
    out[k] = n;
  }
  return { value: out };
}

export async function getArrivalSettings(db = pool) {
  const { rows } = await db.query("SELECT delivery_arrival FROM app_settings WHERE id = 1");
  return normalizeArrivalSettings(rows[0]?.delivery_arrival);
}

export async function saveArrivalSettings(patch, db = pool) {
  const before = await getArrivalSettings(db);
  const after = { ...before, ...patch };
  await db.query(
    `INSERT INTO app_settings (id, delivery_arrival) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET delivery_arrival = EXCLUDED.delivery_arrival`,
    [JSON.stringify(after)]
  );
  return { before, after };
}

// The driver's open stops for today, grouped by customer (one customer can have several orders on the route).
async function openStopsByCustomer(driverId, now, db = pool) {
  const { rows } = await db.query(
    `SELECT rs.id AS stop_id, rs.arrived_at, o.id AS order_id, o.order_code, o.status, o.total_amd,
            c.id AS customer_id, c.name AS customer_name, c.lat, c.lng
     FROM route_stops rs
     JOIN delivery_routes r ON r.id = rs.route_id
     JOIN orders o ON o.id = rs.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE r.driver_id = $1 AND r.route_date = $2 AND rs.completed_at IS NULL
       AND o.status IN ('confirmed', 'packed_stock_out') AND c.lat IS NOT NULL AND c.lng IS NOT NULL
     ORDER BY rs.sequence`,
    [driverId, yerevanToday(now)]
  );
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.customer_id)) groups.set(r.customer_id, { customer_id: r.customer_id, customer_name: r.customer_name, lat: Number(r.lat), lng: Number(r.lng), stops: [] });
    groups.get(r.customer_id).stops.push(r);
  }
  return [...groups.values()];
}

const orderView = (r) => ({ id: r.order_id, order_code: r.order_code, status: r.status, total_amd: Number(r.total_amd) });

// One position report from the driver's phone. Returns what the screen should show: { mode, arrival: null | { ... } }.
export async function handleArrivalPing(user, { lat, lng, accuracy }, now = new Date()) {
  const s = await getArrivalSettings();
  if (s.mode === "off") return { mode: "off", arrival: null };
  const acc = Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
  if (acc != null && acc > ARRIVAL_MAX_ACCURACY_M) return { mode: s.mode, arrival: null, weak_gps: true };

  const groups = await openStopsByCustomer(user.id, now);
  let nearest = null;
  for (const g of groups) {
    g.distance = haversineMeters(lat, lng, g.lat, g.lng);
    g.credited = creditedDistanceMeters(g.distance, acc);
    if (!nearest || g.distance < nearest.distance) nearest = g;
  }
  // Customers the driver walked away from: forget the arrival so the next visit starts the clock again.
  const left = groups.filter((g) => g.credited > s.radius_m + LEAVE_MARGIN_M && g.stops.some((x) => x.arrived_at)).flatMap((g) => g.stops.map((x) => x.stop_id));
  if (left.length) await pool.query("UPDATE route_stops SET arrived_at = NULL, arrival_distance_m = NULL WHERE id = ANY($1)", [left]);

  if (!nearest || nearest.credited > s.radius_m) return { mode: s.mode, arrival: null, open_customers: groups.length };

  const distanceM = Math.round(nearest.distance);
  const stopIds = nearest.stops.map((x) => x.stop_id);
  const { rows } = await pool.query(
    `UPDATE route_stops SET arrived_at = COALESCE(arrived_at, $2), arrival_distance_m = COALESCE(arrival_distance_m, $3)
     WHERE id = ANY($1) RETURNING arrived_at`,
    [stopIds, now, distanceM]
  );
  const arrivedAt = new Date(Math.min(...rows.map((r) => new Date(r.arrived_at).getTime())));
  const ready = now.getTime() - arrivedAt.getTime() >= s.dwell_seconds * 1000;
  const arrival = {
    customer_id: nearest.customer_id,
    customer_name: nearest.customer_name,
    distance_m: distanceM,
    arrived_at: arrivedAt.toISOString(),
    ready,
    orders: nearest.stops.map(orderView),
    auto_delivered: [],
  };
  if (s.mode === "auto" && ready) {
    arrival.auto_delivered = await deliverStops(user, nearest, { how: "auto", reason: `Delivered automatically - the driver arrived (${distanceM} m from the customer)` });
  }
  return { mode: s.mode, arrival, open_customers: groups.length };
}

async function deliverStops(user, group, { how, reason }) {
  const client = await pool.connect();
  let delivered;
  try {
    await client.query("BEGIN");
    delivered = await moveOrdersToDelivered(client, { customerId: group.customer_id, orderIds: group.stops.map((x) => x.order_id), userId: user.id, reason });
    if (delivered.length) await client.query("UPDATE route_stops SET completed_by_arrival = $2 WHERE order_id = ANY($1)", [delivered.map((d) => d.id), how]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  notifyCheckinDelivered({ delivered, customerName: group.customer_name, actorId: user.id, how: how === "auto" ? "ավտոմատ" : "ժամանելուց հետո" });
  return delivered;
}

// The driver tapped "Delivered" on the arrival banner. Only for a customer the driver has really arrived at (arrived_at is set).
export async function deliverOnArrival(user, customerId, now = new Date()) {
  const s = await getArrivalSettings();
  if (s.mode === "off") return { error: "Arrival delivery is switched off", status: 409 };
  const group = (await openStopsByCustomer(user.id, now)).find((g) => g.customer_id === Number(customerId) && g.stops.some((x) => x.arrived_at));
  if (!group) return { error: "No open stop for this customer where you have arrived", status: 404 };
  const delivered = await deliverStops(user, group, { how: "one_tap", reason: "Delivered - one tap by the driver on arrival" });
  return { delivered };
}
