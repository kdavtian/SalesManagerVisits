import { getLockdownState } from "../settings.js";

// A tiny allow-list of paths that must keep working while lockdown is on --
// otherwise nobody, including the admin who flipped it on, could ever get
// back in to lift it. Everything else (every API route, every static
// asset besides the app shell itself) is rejected outright: per the
// feature's spec, lockdown means no data on any device, not "read-only",
// and not "admins are exempt" -- an admin has to log back in (their old
// cookie is invalidated too, see routes/lockdown.js) and gets nothing but
// the lift-lockdown screen either.
const ALWAYS_ALLOWED = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/lockdown",
]);

// req.path is the raw, undecoded pathname off the request line -- comparing
// it directly against ALWAYS_ALLOWED/"/api/" is unsafe because Express's
// own downstream routing (case-insensitive by default, and tolerant of
// repeated slashes and percent-encoded separators) is far more permissive
// than a strict string comparison here would be. Without this, "/API/…",
// "//api/…", or "/api%2F…" all fail both checks below (they don't exact-
// match the allow-list and don't start with "/api/") and fall through to
// the "must be a static asset" branch -- letting a locked-down request
// straight through to a real data-serving route underneath. Normalizing
// first (repeatedly decoding to also catch double-encoding like %252F,
// lowercasing, and collapsing duplicate slashes) closes that gap. Malformed
// percent-encoding fails closed (treated as an API path, blocked while
// locked down) rather than being let through as "clearly just an asset".
function normalizePath(rawPath) {
  let decoded = rawPath;
  try {
    let previous;
    do {
      previous = decoded;
      decoded = decodeURIComponent(previous);
    } while (decoded !== previous);
  } catch {
    return null;
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
}

export async function lockdownGate(req, res, next) {
  const normalized = normalizePath(req.path);

  if (normalized !== null && (ALWAYS_ALLOWED.has(normalized) || normalized === "/api/lockdown/lift")) {
    return next();
  }
  // Static assets and the SPA shell itself must still load, otherwise the
  // lockdown screen (which is part of the normal app bundle) could never
  // render in the first place. Only /api/* beyond the allow-list above is
  // actually blocked -- and anything we failed to normalize is treated as
  // an API path rather than assumed safe.
  if (normalized !== null && !normalized.startsWith("/api/")) {
    return next();
  }

  const { enabled } = await getLockdownState();
  if (!enabled) {
    return next();
  }
  res.status(423).json({ error: "System is in emergency lockdown", locked: true });
}
