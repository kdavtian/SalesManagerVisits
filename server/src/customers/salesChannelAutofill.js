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
  const { rows: owned } = await pool.query(
    "SELECT code FROM sales_channels WHERE manager_user_id = $1 AND active = true ORDER BY display_order, code",
    [req.user.id]
  );
  const submitted = String(req.body?.sales_channel ?? "").trim();
  let resolved = owned.some((r) => r.code === submitted) ? submitted : owned[0]?.code ?? "";

  // every guess below must be an ACTIVE direction: a guess the admin turned off would make the customer impossible to save (the field is
  // hidden from the rep), and a customer queued offline would be dropped by the queue on that refusal (review 2026-11-12)
  const isActive = async (code) => {
    if (!code) return false;
    const { rows } = await pool.query("SELECT 1 FROM sales_channels WHERE active = true AND code = $1", [code]);
    return rows.length > 0;
  };

  // A position that IS a direction's code ("SM Gyumri") is that direction -- before the word guesses below, which would read "Gyumri" as
  // SM Shirak.
  if (!resolved && req.user.position) {
    const { rows } = await pool.query("SELECT code FROM sales_channels WHERE active = true AND lower(code) = lower($1)", [String(req.user.position).trim()]);
    if (rows[0]) resolved = rows[0].code;
  }
  // the old word guesses from the position, for a rep not wired up in sales_channels yet
  if (!resolved) {
    const guess = channelFromPosition(req.user.position);
    if (await isActive(guess)) resolved = guess;
  }
  // Legacy manager records may not yet have a structured/recognizable position: the most common direction of the rep's own customers, when
  // it is an active direction (as before: a book dominated by an unknown value guesses nothing).
  if (!resolved) {
    const { rows } = await pool.query(
      `SELECT sales_channel, COUNT(*)::int AS uses
         FROM customers
        WHERE assigned_manager_id = $1 AND sales_channel IS NOT NULL
        GROUP BY sales_channel
        ORDER BY uses DESC, sales_channel
        LIMIT 1`,
      [req.user.id]
    );
    if (await isActive(rows[0]?.sales_channel)) resolved = rows[0].sales_channel;
  }

  // nothing could be worked out: what the form sent stays (the customer route checks it is a known direction)
  if (resolved) req.body.sales_channel = resolved;
  next();
}
