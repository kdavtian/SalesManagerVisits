import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessReport } from "../reports.js";
import { canManageFuel } from "../roles.js";
import { buildFuelReport, isMonth } from "../fuelReport.js";
import { retryFailedRoutes } from "../fuelRoute.js";
import { yerevanMonthStart } from "../utils/yerevanDate.js";

export const fuelRouter = Router();
fuelRouter.use(requireAuth);

async function requireView(req, res, next) {
  if (await canAccessReport(req.user.role, "fuel_allowance")) return next();
  res.status(403).json({ error: "Not allowed" });
}
function requireManage(req, res, next) {
  if (canManageFuel(req.user.role)) return next();
  res.status(403).json({ error: "Only the owner can change fuel settings" });
}
const monthOf = (q) => (isMonth(q) ? q : yerevanMonthStart().slice(0, 7));

fuelRouter.get("/report", requireView, async (req, res) => {
  const month = monthOf(req.query.month);
  if (req.query.retry === "1") retryFailedRoutes();
  const report = await buildFuelReport({ month });
  res.json({ ...report, can_manage: canManageFuel(req.user.role) });
});

const csvCell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
fuelRouter.get("/report.csv", requireView, async (req, res) => {
  const month = monthOf(req.query.month);
  const report = await buildFuelReport({ month });
  const lines = [["Rep", "Date", "Km", "City km", "Highway km", "City L/100km", "Highway L/100km", "Liters", "Fuel price", "Amount AMD", "Note"].map(csvCell).join(",")];
  for (const rep of report.reps) {
    for (const d of [...rep.days].reverse()) {
      lines.push([rep.name, d.date, d.km, d.city_km, d.highway_km, rep.fuel_l_per_100km ?? "", rep.fuel_highway_l_per_100km ?? "", d.liters ?? "", report.price_amd_per_l ?? "", d.amount ?? "", d.override?.note ?? (d.estimated ? "estimated distance" : "")].map(csvCell).join(","));
    }
    lines.push([`${rep.name} TOTAL`, "", rep.totals.km, rep.totals.city_km, rep.totals.highway_km, rep.fuel_l_per_100km ?? "", rep.fuel_highway_l_per_100km ?? "", rep.totals.liters ?? "", report.price_amd_per_l ?? "", rep.totals.amount ?? "", ""].map(csvCell).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fuel-${month}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));
});

// Reps with their fuel settings (consumption, home) + the price of one month.
fuelRouter.get("/settings", requireView, async (req, res) => {
  const month = monthOf(req.query.month);
  const { rows: reps } = await pool.query(
    `SELECT id, name, name_hy, fuel_l_per_100km, fuel_highway_l_per_100km, home_address, home_lat, home_lng
     FROM users
     WHERE role = 'sales_manager' OR id IN (SELECT user_id FROM checkins WHERE timestamp > now() - interval '60 days')
     ORDER BY name`
  );
  const { rows } = await pool.query("SELECT price_amd_per_l FROM fuel_prices WHERE month = $1", [`${month}-01`]);
  res.json({ month, price_amd_per_l: rows[0] ? Number(rows[0].price_amd_per_l) : null, reps, can_manage: canManageFuel(req.user.role) });
});

fuelRouter.put("/settings/users/:id", requireManage, async (req, res) => {
  const { fuel_l_per_100km, fuel_highway_l_per_100km, home_address, home_lat, home_lng } = req.body ?? {};
  const sets = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  for (const [col, raw] of [["fuel_l_per_100km", fuel_l_per_100km], ["fuel_highway_l_per_100km", fuel_highway_l_per_100km]]) {
    if (raw === undefined) continue;
    const n = raw === null || raw === "" ? null : Number(raw);
    if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 60)) return res.status(400).json({ error: "Consumption must be between 0 and 60 L/100km" });
    add(col, n);
  }
  if (home_address !== undefined || home_lat !== undefined || home_lng !== undefined) {
    const lat = home_lat === null || home_lat === undefined || home_lat === "" ? null : Number(home_lat);
    const lng = home_lng === null || home_lng === undefined || home_lng === "" ? null : Number(home_lng);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180))) {
      return res.status(400).json({ error: "Home location needs a valid latitude and longitude" });
    }
    add("home_address", home_address ? String(home_address).slice(0, 300) : null);
    add("home_lat", lat);
    add("home_lng", lng);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, name, fuel_l_per_100km, fuel_highway_l_per_100km, home_address, home_lat, home_lng`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

fuelRouter.put("/prices/:month", requireManage, async (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const price = Number(req.body?.price_amd_per_l);
  if (!Number.isFinite(price) || price <= 0 || price > 5000) return res.status(400).json({ error: "Enter the fuel price in AMD per litre" });
  await pool.query(
    `INSERT INTO fuel_prices (month, price_amd_per_l, set_by) VALUES ($1, $2, $3)
     ON CONFLICT (month) DO UPDATE SET price_amd_per_l = EXCLUDED.price_amd_per_l, set_by = EXCLUDED.set_by, updated_at = now()`,
    [`${req.params.month}-01`, price, req.user.id]
  );
  res.json({ month: req.params.month, price_amd_per_l: price });
});

// Correct one rep-day's distance (a GPS glitch, a detour the check-ins don't
// show). km: null removes the correction.
fuelRouter.put("/overrides", requireManage, async (req, res) => {
  const { user_id, day, km, note } = req.body ?? {};
  if (!Number.isInteger(Number(user_id)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return res.status(400).json({ error: "user_id and day are required" });
  if (km === null) {
    await pool.query("DELETE FROM fuel_day_overrides WHERE user_id = $1 AND day = $2", [user_id, day]);
    return res.status(204).end();
  }
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0 || n > 2000) return res.status(400).json({ error: "km must be between 0 and 2000" });
  await pool.query(
    `INSERT INTO fuel_day_overrides (user_id, day, km, note, set_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, day) DO UPDATE SET km = EXCLUDED.km, note = EXCLUDED.note, set_by = EXCLUDED.set_by, updated_at = now()`,
    [user_id, day, n, note ? String(note).slice(0, 300) : null, req.user.id]
  );
  res.status(204).end();
});
