// Single entry point for every notification a user receives: records it in
// the `notifications` table (what their in-app Notifications page reads
// from) and, unless they've turned this type off in Settings, also pushes
// it to their device via Web Push. Trigger sites call this one function
// instead of separately checking the preference and calling push.js, so
// there's no way to record an inbox row while forgetting the push (or vice
// versa) at a given call site.
import { pool } from "./db/pool.js";
import { isNotificationEnabled } from "./notificationPreferences.js";
import { notifyUser as sendPush } from "./push.js";

export async function notifyUser(userId, type, { title, body, url } = {}) {
  if (!(await isNotificationEnabled(userId, type))) return;

  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, url) VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, body, url ?? null]
  );

  sendPush(userId, { title, body, url });
}
