// Minimum app version for saves (Phase 0 item 0.21, owner 2026-11-28). The phones send their version in X-App-Version (client api/core.js);
// a phone that never updates kept saving with old rules for weeks. With MIN_APP_VERSION set (environment, e.g. "1.611.0"; empty = off, the
// default), a change (POST/PUT/PATCH/DELETE) from an OLDER phone gets 426 "update_required": the phone keeps the work in its offline queue,
// shows the update screen without "Later" and sends the work after updating. Reads are never refused (the rep can still look things up).
// Callers that send no X-App-Version -- the CEO bot, the integration API, KAD OS, scripts -- are never affected. Sign-in / sign-out and
// the client error reports always pass. The minimum is never higher than the app this server ships (a typo cannot lock every phone out).
import fs from "node:fs";
import path from "node:path";
import { CLIENT_PUBLIC_DIR } from "../shared/paths.js";

// The first app version that understands 426 (keeps the save in its queue, shows the update screen). An older phone treats any other 4xx
// as "refused" and DELETES its queued work, so it gets 503 instead -- which every app version keeps in the queue and retries -- with the
// same "update the app" text, which its screens show as the error.
export const FIRST_426_AWARE = [1, 611, 0];
const MESSAGE = "Թարմացրեք հավելվածը / Update the app: this version is too old to save.";

const EXEMPT = /^\/api\/(auth|client-errors|integration|ops|erp-sync)(\/|$)/;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// "1.610.0" -> [1, 610, 0]; anything that is not a version -> null
export function parseVersion(value) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(String(value ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

let shippedCache;
function shippedVersion() {
  if (shippedCache !== undefined) return shippedCache;
  try {
    const text = fs.readFileSync(path.join(CLIENT_PUBLIC_DIR, "js/version.js"), "utf8");
    shippedCache = parseVersion(text.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1]);
  } catch {
    shippedCache = null;
  }
  return shippedCache;
}

// The minimum in force now, or null when off. Read on every call (cheap) so a test or a restart with a new value applies at once.
export function minAppVersion(env = process.env) {
  const min = parseVersion(env.MIN_APP_VERSION);
  if (!min) return null;
  const shipped = shippedVersion();
  return shipped && compareVersions(min, shipped) > 0 ? shipped : min;
}

export function requireCurrentApp(req, res, next) {
  return checkAppVersion(req, res, next, minAppVersion());
}

// The rule itself, with the minimum given (tests check the 426 path with a minimum above the shipped app).
export function checkAppVersion(req, res, next, min) {
  if (READ_METHODS.has(req.method) || EXEMPT.test(req.originalUrl || req.url)) return next();
  const sent = req.get("X-App-Version");
  if (!sent) return next();
  if (!min) return next();
  const phone = parseVersion(sent);
  if (phone && compareVersions(phone, min) >= 0) return next();
  const aware = phone && compareVersions(phone, FIRST_426_AWARE) >= 0;
  return res.status(aware ? 426 : 503).json({ error: MESSAGE, code: "update_required", min_version: min.join(".") });
}
