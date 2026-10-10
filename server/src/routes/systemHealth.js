// Admin "System health": one glance at whether the deployment is what you think it is -- the app
// version this server actually serves (vs the one open on your phone), the service-worker cache
// version, applied migrations, how fresh each ERP feed from the bot is, the latest Excel dates in
// the data, and which integrations are configured (booleans only, never the secrets themselves).
// It answers the "Not updated" / "no data today" questions without SSH.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { erpSyncFreshness, ERP_STALE_AFTER_HOURS } from "../erpSyncFreshness.js";
import { SOURCES, dailyReportFreshness } from "../erpSyncMonitor.js";

export const systemHealthRouter = Router();
systemHealthRouter.use(requireAuth, requireAdmin);

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, "..", "..", "..", "client", "public");
const migrationsDir = path.join(here, "..", "..", "migrations");

function readConstant(file, pattern) {
  try {
    return fs.readFileSync(path.join(clientDir, file), "utf8").match(pattern)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function migrationStatus() {
  const applied = new Set((await pool.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename));
  let files = [];
  try {
    files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // migrations folder not shipped next to the server (unusual): report what the database knows
  }
  const pending = files.filter((f) => !applied.has(f));
  const latest = [...applied].sort().pop() ?? null;
  return { applied: applied.size, latest, pending };
}

systemHealthRouter.get("/", async (req, res) => {
  const t0 = Date.now();
  await pool.query("SELECT 1");
  const dbMs = Date.now() - t0;

  const sources = await Promise.all([
    ...SOURCES.map(async (s) => ({ key: s.key, label: s.label, ...(await erpSyncFreshness(s.table)) })),
    dailyReportFreshness().then((f) => ({ key: "erp_daily_report", label: "Օրական հաշվետվություն", ...f })),
  ]);
  const [{ rows: dates }, migrations, { rows: digest }] = await Promise.all([
    pool.query(
      `SELECT (SELECT MAX(order_date) FROM erp_order_lines) AS latest_order_date,
              (SELECT MAX(report_date) FROM erp_daily_report WHERE period = 'daily') AS latest_report_date,
              (SELECT COUNT(*)::int FROM erp_customer_data) AS erp_customers`
    ),
    migrationStatus(),
    pool.query("SELECT MAX(snapshot_date) AS last_digest FROM debt_digest_snapshots"),
  ]);

  res.json({
    now: new Date().toISOString(),
    server_version: readConstant("js/version.js", /APP_VERSION\s*=\s*"([^"]+)"/),
    cache_version: readConstant("sw.js", /CACHE_VERSION\s*=\s*"([^"]+)"/),
    uptime_seconds: Math.round(process.uptime()),
    database: { ok: true, latency_ms: dbMs },
    migrations,
    erp: { stale_after_hours: ERP_STALE_AFTER_HOURS, sources, ...dates[0] },
    integrations: {
      push: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_NOTIFY_CHAT_IDS),
      erp_sync_key: Boolean(process.env.ERP_SYNC_KEY),
    },
    last_debt_digest: digest[0]?.last_digest ?? null,
  });
});
