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

// Both a transient failure (network blip, the push service having a bad
// moment) and a permanent one (subscription revoked, browser uninstalled)
// show up as webpush.sendNotification() throwing -- only 404/410 reliably
// mean "gone for good" (see notifyOneSubscription below). Everything else
// gets a short bounded retry in-process rather than being dropped after a
// single attempt, which is what silently happened before this.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3000, 15000]; // before attempt 2, then attempt 3

async function logDeliveryAttempt({ notificationId, userId, subscriptionId, status, statusCode, errorMessage, attempt }) {
  try {
    await pool.query(
      `INSERT INTO notification_delivery_log (notification_id, user_id, subscription_id, status, status_code, error_message, attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [notificationId ?? null, userId, subscriptionId, status, statusCode ?? null, errorMessage ?? null, attempt]
    );
  } catch (err) {
    // The delivery log is itself best-effort -- losing one log row is far
    // better than a logging failure taking down the push attempt it's
    // trying to record.
    console.error("Failed to record notification_delivery_log row:", err.message);
  }
}

async function notifyOneSubscription(row, payload, userId, notificationId, attempt = 1) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload)
    );
    console.log(`Push delivered to subscription ${row.id} (user ${userId}): "${payload.title}"`);
    await logDeliveryAttempt({ notificationId, userId, subscriptionId: row.id, status: "delivered", statusCode: 200, attempt });
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log(`Subscription ${row.id} (user ${userId}) expired (${err.statusCode}) -- removing it.`);
      await logDeliveryAttempt({
        notificationId,
        userId,
        subscriptionId: row.id,
        status: "expired",
        statusCode: err.statusCode,
        errorMessage: err.message,
        attempt,
      });
      await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
      return;
    }

    console.error(`Push notify error for subscription ${row.id} (status ${err.statusCode}, attempt ${attempt}):`, err.message);
    await logDeliveryAttempt({
      notificationId,
      userId,
      subscriptionId: row.id,
      status: "failed",
      statusCode: err.statusCode,
      errorMessage: err.message,
      attempt,
    });

    if (attempt < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      setTimeout(() => {
        notifyOneSubscription(row, payload, userId, notificationId, attempt + 1).catch((retryErr) =>
          console.error("Push retry itself threw:", retryErr.message)
        );
      }, delay);
    }
  }
}

// Sends to every subscription the user has (they could have this enabled
// on more than one device). A subscription the push service reports as
// gone (410) or not-found (404) is expired -- deleted so it stops being
// retried on every future notification. Every attempt (success, permanent
// failure, or transient failure awaiting retry) is recorded in
// notification_delivery_log -- see routes/notifications.js's admin-only
// GET /delivery-log for the visible side of this.
export async function notifyUser(userId, payload, notificationId = null) {
  if (!enabled) return;

  const { rows } = await pool.query(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
    [userId]
  );
  if (!rows.length) return;

  await Promise.all(rows.map((row) => notifyOneSubscription(row, payload, userId, notificationId)));
}
