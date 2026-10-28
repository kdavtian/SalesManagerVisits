// Alerts admin/CEO when the Castrol ERP sync pipeline goes quiet -- the bot
// (kdavtian/castrol_ceo_report, running on its own droplet) pushes on every
// Telegram workbook upload, wraps every push in try/except, and only logs a
// failure to its own journal. Nothing on that side tells a human when a
// push stops arriving; this is the app-side alarm for exactly that.
//
// Run hourly by the background job scheduler (jobs/index.js), only when push
// is set up. Reuses the same ERP_STALE_AFTER_HOURS threshold the Reports
// API's own freshness badges use (routes/reports.js), so "the report shows
// a warning badge" and "admin/CEO got a push about it" never disagree.

import { pool } from "./db/pool.js";
import { enabled as pushEnabled } from "./push.js";
import { notifyUser } from "./notifications.js";
import { erpSyncFreshness, ERP_STALE_AFTER_HOURS } from "./erpSyncFreshness.js";
import { getSyncStatus } from "./erpSyncStatus.js";


const ALERT_ROLES = ["admin", "ceo", "operations_director"];

// One check per POST /api/erp-sync endpoint (see docs/erp-sync-contract.md):
// the main extract, the daily-report snapshot, and the generated-report
// files. Each can go stale independently of the others -- the bot best-
// effort-pushes each on its own, so one silently failing doesn't imply the
// others did too.
export const SOURCES = [
  { key: "erp_customer_data", table: "erp_customer_data", label: "Debt/հաճախորդների քաղվածք" },
  { key: "sales_performance", table: "sales_performance", label: "Վաճառքի ցուցանիշներ" },
  { key: "perf_actuals_brand_monthly", table: "perf_actuals_brand_monthly", label: "Բրենդի ծավալներ" },
  { key: "generated_reports", table: "generated_reports", label: "Պատրաստի հաշվետվություններ (Excel)" },
];

// erp_daily_report carries multiple periods in one table -- only "daily" is
// checked here, same as the report page's own default, since that's the one
// period the bot is expected to push every single run (see
// sync_field_visits.sync_all_period_reports).
export async function dailyReportFreshness() {
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

  // One notification per check, however many sources stalled together (the
  // bot's workbook upload feeds all five at once, so a dead bot used to
  // produce five near-identical alerts -- owner, 2026-10-18). The alert goes
  // out when at least one source is newly stalled and lists every source
  // that is stalled right now as bullet lines.
  const stale = [];
  let newlyStale = false;
  for (const check of checks) {
    const freshness = await check.freshnessPromise;
    if (freshness.stale) {
      stale.push({ ...check, synced_at: freshness.synced_at });
      if (!alreadyAlerted.has(check.key)) {
        alreadyAlerted.add(check.key);
        newlyStale = true;
      }
    } else {
      alreadyAlerted.delete(check.key);
    }
  }
  if (!newlyStale) return;
  const lines = stale.map((c) => `• ${c.label} (${formatSyncedAt(c.synced_at)})`).join("\n");
  const body =
    stale.length === 1
      ? `${stale[0].label}-ը չի թարմացվել ${ERP_STALE_AFTER_HOURS} ժամից ավելի (վերջին անգամ՝ ${formatSyncedAt(stale[0].synced_at)})։ Ստուգեք Castrol բոտի կապը։`
      : `Չեն թարմացվել ${ERP_STALE_AFTER_HOURS} ժամից ավելի (վերջին անգամ՝ փակագծերում)՝\n${lines}\nՍտուգեք Castrol բոտի կապը։`;
  for (const recipient of recipients.rows) {
    await notifyUser(recipient.id, "erp_sync_stale", { title: "ERP համաժամացումը կանգնած է", body, url: "/#/reports" });
  }
}


// The Excel FILE itself getting old (owner, 2026-10-24): the bot can sync every day while the accountant posts no new workbook, so the
// sync-age alarm above stays quiet although the numbers are days behind. Alerts admin / CEO / operations director once per file date when the
// newest workbook the bot synced is older than WORKBOOK_STALE_AFTER_HOURS (Saturdays and Sundays not counted), in the daytime only (Yerevan, UTC+4). "Once per file" is
// remembered in the notifications table itself (same body), so a deploy/restart does not repeat it.
export const WORKBOOK_STALE_AFTER_HOURS = 48;
const DAYTIME_HOURS = [8, 21]; // Yerevan: from 08:00 until 21:00

function yerevanHour(now) {
  return (now.getUTCHours() + 4) % 24;
}

// Hours between two moments WITHOUT the Saturdays and Sundays (Yerevan time): the accountant posts no file at the weekend, so a Friday file is
// not "old" on Monday morning (owner, 2026-10-24).
export function hoursWithoutWeekends(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  const DAY = 24 * 3600 * 1000;
  const shift = 4 * 3600 * 1000; // Yerevan = UTC+4: shift so that a UTC calendar day is a Yerevan day
  let weekend = 0;
  for (let day = Math.floor((fromMs + shift) / DAY) * DAY; day < toMs + shift; day += DAY) {
    const dow = new Date(day).getUTCDay(); // 0 Sunday, 6 Saturday
    if (dow !== 0 && dow !== 6) continue;
    weekend += Math.max(0, Math.min(day + DAY, toMs + shift) - Math.max(day, fromMs + shift));
  }
  return (toMs - fromMs - weekend) / 3.6e6;
}

// `only` (tests): notify just these user ids -- the tests run against the production database and must never message real admins.
export async function checkWorkbookAge({ now = new Date(), anyHour = false, only = null } = {}) {
  const status = await getSyncStatus();
  const fileDate = status.last_success?.workbook_modified_at;
  if (!fileDate) return { alerted: false, reason: "no file date" };
  const ageHours = hoursWithoutWeekends(new Date(fileDate).getTime(), now.getTime());
  if (ageHours <= WORKBOOK_STALE_AFTER_HOURS) return { alerted: false, reason: "fresh" };
  const hour = yerevanHour(now);
  if (!anyHour && (hour < DAYTIME_HOURS[0] || hour >= DAYTIME_HOURS[1])) return { alerted: false, reason: "night" };

  const fileLabel = new Date(fileDate).toLocaleDateString("hy-AM", { day: "numeric", month: "long", timeZone: "Asia/Yerevan" });
  const days = Math.floor(ageHours / 24);
  const body = `Castrol Excel ֆայլի վերջին տարբերակը ${fileLabel}-ինն է (${days} օր առաջ)։ Տվյալները հետ են մնում․ խնդրեք հաշվապահին ուղարկել նոր ֆայլը Telegram խումբ։`;
  const seen = await pool.query("SELECT 1 FROM notifications WHERE type = 'erp_sync_stale' AND body = $1 LIMIT 1", [body]);
  if (seen.rowCount > 0) return { alerted: false, reason: "already told" };
  const recipients = only
    ? { rows: only.map((id) => ({ id })), rowCount: only.length }
    : await pool.query("SELECT id FROM users WHERE role = ANY($1) AND status = 'active'", [ALERT_ROLES]);
  for (const recipient of recipients.rows) {
    await notifyUser(recipient.id, "erp_sync_stale", { title: "Excel ֆայլը հնացել է", body, url: "/#/settings?section=system-health" });
  }
  return { alerted: true, recipients: recipients.rowCount };
}
