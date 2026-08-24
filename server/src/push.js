// Web Push straight to a rep's own device (phone home-screen PWA or
// desktop browser) -- separate from telegram.js, which only reaches a
// fixed admin/CEO channel. Silently disabled (logged once at boot) if
// unconfigured, same pattern as Telegram and ERP_SYNC_KEY.

import webpush from "web-push";
import { pool } from "./db/pool.js";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

export const enabled = Boolean(PUBLIC_KEY && PRIVATE_KEY);
export const vapidPublicKey = PUBLIC_KEY || null;

if (!enabled) {
  console.warn(
    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set -- push notifications are disabled. " +
      "Generate a pair with `npx web-push generate-vapid-keys`."
  );
} else {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

// Sends to every subscription the user has (they could have this enabled
// on more than one device). A subscription the push service reports as
// gone (410) or not-found (404) is expired -- deleted so it stops being
// retried on every future notification.
export async function notifyUser(userId, payload) {
  if (!enabled) return;

  const { rows } = await pool.query(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
    [userId]
  );
  if (!rows.length) return;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
        } else {
          // Never let a notification failure break the request that
          // triggered it -- this is a best-effort side channel.
          console.error(`Push notify error for subscription ${row.id}:`, err.message);
        }
      }
    })
  );
}
