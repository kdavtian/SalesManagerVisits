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

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, url) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, type, title, body, url ?? null]
    ));
  } catch (err) {
    // 23503 = foreign_key_violation: the user was deleted between the trigger
    // and this insert (callers fire notifyUser() without awaiting it, so this
    // used to surface as an unhandledRejection, e.g. in CI after a test's
    // cleanup). Nobody left to notify -- not an error.
    if (err.code === "23503") return;
    throw err;
  }

  // Awaited and caught here, not left to run unattached -- most callers
  // (order/payment/plan notification fan-outs) call notifyUser() itself
  // without awaiting it, inside a try/catch that only guards synchronous
  // work in the same tick. An unawaited sendPush() failing later (e.g. a
  // push subscription row whose user was deleted in the meantime) used to
  // surface as an unhandled rejection with no connection to whatever
  // request or test triggered it (see R-07 in the risk register --
  // observed as an intermittent, hard-to-reproduce CI failure in
  // orderLifecycle.test.js). notifyUser() now never rejects because of a
  // push-delivery failure; a real DB outage on the INSERT above still
  // throws normally, since that's a genuine failure the caller should see.
  try {
    await sendPush(userId, { title, body, url }, rows[0].id);
  } catch (err) {
    console.error(`Push delivery failed for user ${userId}:`, err);
  }
}
