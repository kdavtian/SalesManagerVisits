import { pool } from "./db/pool.js";

const VALID_CHANNELS = new Set(["KF", "CAS", "OEM", "CVO", "PCO", "SM B2B", "SM YVN", "SM Davtashen", "SM Shirak", "SM CAS"]);

function channelFromPosition(position = "") {
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

  // requireAuth already loaded the user's position. For correctly configured
  // manager accounts this resolves without another DB round trip.
  let resolved = channelFromPosition(req.user.position);

  // Legacy manager records may not yet have a structured/recognizable
  // position. In that case infer from the manager's existing customer book.
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
    const dominant = rows[0]?.sales_channel;
    if (VALID_CHANNELS.has(dominant)) resolved = dominant;
  }

  if (resolved) req.body.sales_channel = resolved;
  next();
}
