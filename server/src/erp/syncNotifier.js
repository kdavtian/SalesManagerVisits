// ONE notification per person per ERP sync run. A bot run touches the app several times (customers/debt,
// products, daily report, up to 3 generated workbooks) and each effect used to notify on its own:
// "new data available" for management, "prices changed" for the sales team, "N new tasks" for each rep,
// "payment promise broken" for the sales director. Everything a sync produces is queued here instead and
// sent after a quiet period as a single combined notification per recipient (their own preferences are
// still respected per kind: a person who switched "prices changed" off simply does not get that line).
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { isNotificationEnabled } from "../shared/notificationPreferences.js";

// Short in tests (same NODE_ENV-gated pattern as push.js / telegram.js).
// SYNC_NOTICE_QUIET_MS lets one test widen the window (two calls 60 ms apart used to land in two notifications on a slow runner); read per call.
const quietPeriodMs = () => Number(process.env.SYNC_NOTICE_QUIET_MS) || (process.env.NODE_ENV === "test" ? 50 : 45_000);
const REPORT_ROLES = ["admin", "ceo", "operations_director", "sales_director", "accountant"];

let notices = []; // { type, roles, userIds, text, url, order }
let reportLabels = [];
let timer = null;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    flushSyncNotices().catch((err) => console.error("Failed to send combined sync notification:", err));
  }, quietPeriodMs());
}

// A report/file that just became available (shown as "X-ը այժմ հասանելի է").
export function queueReportLabel(label) {
  reportLabels.push(label);
  schedule();
}

// Any other effect of the sync for some people: type = its notification type (preferences), roles/userIds = who.
export function queueSyncNotice({ type, roles = [], userIds = [], text, url, title = null, order = 5 }) {
  notices.push({ type, roles, userIds, text, url, title, order });
  schedule();
}

const reportText = (labels) => (labels.length === 1 ? `${labels[0]}-ը այժմ հասանելի է` : `${labels.join(", ")}-ը այժմ հասանելի են`);

export async function flushSyncNotices() {
  clearTimeout(timer);
  const batch = notices;
  const labels = reportLabels;
  notices = [];
  reportLabels = [];
  if (labels.length) batch.push({ type: "sync_reports_ready", roles: REPORT_ROLES, userIds: [], text: reportText(labels), url: "/#/reports", order: 0 });
  if (!batch.length) return;

  // recipient -> notices addressed to them
  const perUser = new Map();
  const roleSet = [...new Set(batch.flatMap((n) => n.roles))];
  const { rows: roleUsers } = roleSet.length ? await pool.query("SELECT id, role FROM users WHERE role = ANY($1)", [roleSet]) : { rows: [] };
  for (const n of batch) {
    const ids = new Set([...n.userIds, ...roleUsers.filter((u) => n.roles.includes(u.role)).map((u) => u.id)]);
    for (const id of ids) {
      if (!perUser.has(id)) perUser.set(id, []);
      perUser.get(id).push(n);
    }
  }

  for (const [userId, list] of perUser) {
    const wanted = [];
    for (const n of list) if (await isNotificationEnabled(userId, n.type)) wanted.push(n);
    if (!wanted.length) continue;
    wanted.sort((a, b) => a.order - b.order);
    const single = wanted.length === 1;
    const urls = [...new Set(wanted.map((n) => n.url))];
    await notifyUser(userId, wanted[0].type, {
      title: single && wanted[0].title ? wanted[0].title : "Նոր տվյալներ են հասանելի",
      body: wanted.map((n) => n.text).join(" · "),
      url: urls.length === 1 ? urls[0] : wanted.find((n) => n.url === "/#/reports")?.url ?? wanted[0].url,
    }).catch((err) => console.error("Sync notification failed:", err.message));
  }
}
