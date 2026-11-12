import { pool } from "../db/pool.js";

export function channelFromPosition(position = "") {
  const value = String(position).trim().toLowerCase();
  if (!value) return "";
  if (value.includes("davtashen") || value.includes("դավթաշեն")) return "SM Davtashen";
  if (value.includes("shirak") || value.includes("gyumri") || value.includes("շիրակ") || value.includes("գյումրի")) return "SM Shirak";
  if (value.includes("b2b")) return "SM B2B";
  if (value.includes("sm cas") || value.includes("sales manager cas")) return "SM CAS";
  if (value.includes("yvn") || value.includes("yerevan") || value.includes("երևան")) return "SM YVN";
  return "";
}

export async function autoAssignSalesChannel(req, res, next) {
  if (req.method !== "POST" || req.user?.role !== "sales_manager") return next();

  // sales_channels.manager_user_id is the canonical channel<->manager association (migration 055). A rep who owns SEVERAL directions
  // (owner, 2026-11-12 review: Artak owns SM Davtashen and SM B2B) may choose which one the new customer belongs to; otherwise the first of
  // them in the directions' own order (was an arbitrary one: LIMIT 1 without ORDER BY).
  let resolved = "";
  const { rows: owned } = await pool.query(
    "SELECT code FROM sales_channels WHERE manager_user_id = $1 AND active = true ORDER BY display_order, code",
    [req.user.id]
  );
  const submitted = String(req.body?.sales_channel ?? "").trim();
  if (owned.some((r) => r.code === submitted)) resolved = submitted;
  else if (owned[0]) resolved = owned[0].code;
  // a rep who owns no direction yet: a direction the admin panel knows, sent by the form, is kept (the guesses below are for an empty one)
  if (!resolved && !owned.length && submitted) {
    const { rows } = await pool.query("SELECT code FROM sales_channels WHERE active = true AND code = $1", [submitted]);
    if (rows[0]) return next();
  }

  // A position that IS a direction's code ("SM Gyumri") is that direction -- before the word guesses below, which would read "Gyumri" as
  // SM Shirak.
  if (!resolved && req.user.position) {
    const { rows } = await pool.query("SELECT code FROM sales_channels WHERE active = true AND lower(code) = lower($1)", [String(req.user.position).trim()]);
    if (rows[0]) resolved = rows[0].code;
  }
  // requireAuth already loaded the user's position: the old word guesses, for a rep not wired up in sales_channels yet.
  if (!resolved) resolved = channelFromPosition(req.user.position);

  // Legacy manager records may not yet have a structured/recognizable position: the most common direction of the rep's own customers
  // (one the directions table knows).
  if (!resolved) {
    const { rows } = await pool.query(
      `SELECT c.sales_channel, COUNT(*)::int AS uses
         FROM customers c JOIN sales_channels sc ON sc.code = c.sales_channel AND sc.active
        WHERE c.assigned_manager_id = $1
        GROUP BY c.sales_channel
        ORDER BY uses DESC, c.sales_channel
        LIMIT 1`,
      [req.user.id]
    );
    if (rows[0]?.sales_channel) resolved = rows[0].sales_channel;
  }

  if (resolved) req.body.sales_channel = resolved;
  next();
}
