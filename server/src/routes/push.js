import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { vapidPublicKey, enabled } from "../push.js";

export const pushRouter = Router();

pushRouter.use(requireAuth);

pushRouter.get("/vapid-public-key", (req, res) => {
  res.json({ enabled, key: vapidPublicKey });
});

// The endpoint URL is the natural unique key for a subscription -- a
// re-subscribe from the same browser/device (e.g. after clearing the key
// pair) lands on the same endpoint, so this upserts rather than erroring
// on a duplicate.
pushRouter.post("/", async (req, res) => {
  const { endpoint, keys } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "endpoint and keys.p256dh/keys.auth are required" });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );
  res.status(204).end();
});

pushRouter.delete("/", async (req, res) => {
  const { endpoint } = req.body ?? {};
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [
    endpoint,
    req.user.id,
  ]);
  res.status(204).end();
});
