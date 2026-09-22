// Alerts admin/CEO when the Castrol ERP sync pipeline goes quiet -- the bot
// (kdavtian/castrol_ceo_report, running on its own droplet) pushes on every
// Telegram workbook upload, wraps every push in try/except, and only logs a
// failure to its own journal. Nothing on that side tells a human when a
// push stops arriving; this is the app-side alarm for exactly that.
//
// Same setInterval-in-the-one-process pattern as overdueReminders.js/
// stalePackedReminder.js -- no job runner needed for a single-instance
// deployment. Reuses the same ERP_STALE_AFTER_HOURS threshold the Reports
// API's own freshness badges use (routes/reports.js), so "the report shows
// a warning badge" and "admin/CEO got a push about it" never disagree.

import { pool } from "./db/pool.js";
import { enabled as pushEnabled } from "./push.js";
import { notifyUser } from "./notifications.js";
import { erpSyncFreshness, ERP_STALE_AFTER_HOURS } from "./erpSyncFreshness.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly -- no need to check more often than the staleness window itself

const ALERT_ROLES = ["admin", "ceo", "operations_director"];

// One check per POST /api/erp-sync endpoint (see docs/erp-sync-contract.md):
// the main extract, the daily-report snapshot, and the generated-report
// files. Each can go stale independently of the others -- the bot best-
// effort-pushes each on its own, so one silently failing doesn't imply the
// others did too.
const SOURCES = [
  { key: "erp_customer_data", table: "erp_customer_data", label: "Debt/հաճախորդների քաղվածք" },
  { key: "sales_performance", table: "sales_performance", label: "Վաճառքի ցուցանիշներ" },
  { key: "perf_actuals_brand_monthly", table: "perf_actuals_brand_monthly", label: "Բրենդի ծավալներ" },
  { key: "generated_reports", table: "generated_reports", label: "Պատրաստի հաշվետվություններ (Excel)" },
];

// erp_daily_report carries multiple periods in one table -- only "daily" is
// checked here, same as the report page's own default, since that's the one
// period the bot is expected to push every single run (see
// sync_field_visits.sync_all_period_reports).
async function dailyReportFreshness() {
  const { rows } = await pool.query(`SELECT MAX(synced_at) AS synced_at FROM erp_daily_report WHERE period = 'daily'`);
  const syncedAt = rows[0]?.synced_at ?? null;
  const hoursSinceSync = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) / 3.6e6 : null;
  return { synced_at: syncedAt, stale: hoursSinceSync == null || hoursSinceSync > ERP_STALE_AFTER_HOURS };
}

// Tracks which sources are currently in an alerted state, so a stalled
// source gets exactly one notification, not one per hourly check -- cleared
// the moment a fresh sync lands, so a later stall alerts again.
const alreadyAlerted = new Set();

function formatSyncedAt(syncedAt) {
  if (!syncedAt) return "երբեք";
  return new Date(syncedAt).toLocaleString("hy-AM", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export async function checkErpSyncFreshness() {
  if (!pushEnabled) return;

  const checks = [
    ...SOURCES.map((s) => ({ ...s, freshnessPromise: erpSyncFreshness(s.table) })),
    { key: "erp_daily_report", label: "Օրական հաշվետվություն", freshnessPromise: dailyReportFreshness() },
  ];

  const recipients = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ALERT_ROLES]);

  for (const check of checks) {
    const freshness = await check.freshnessPromise;
    if (freshness.stale) {
      if (alreadyAlerted.has(check.key)) continue;
      alreadyAlerted.add(check.key);
      for (const recipient of recipients.rows) {
        await notifyUser(recipient.id, "erp_sync_stale", {
          title: "ERP համաժամացումը կանգնած է",
          body: `${check.label}-ը չի թարմացվել ${ERP_STALE_AFTER_HOURS} ժամից ավելի (վերջին անգամ՝ ${formatSyncedAt(freshness.synced_at)})։ Ստուգեք Castrol բոտի կապը։`,
          url: "/#/reports",
        });
      }
    } else {
      alreadyAlerted.delete(check.key);
    }
  }
}

export function startErpSyncMonitor() {
  if (!pushEnabled) return;
  setInterval(() => {
    checkErpSyncFreshness().catch((err) => console.error("ERP sync freshness check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
