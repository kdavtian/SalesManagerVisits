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

export async function lockdownGate(req, res, next) {
  if (ALWAYS_ALLOWED.has(req.path) || req.path === "/api/lockdown/lift") {
    return next();
  }
  // Static assets and the SPA shell itself must still load, otherwise the
  // lockdown screen (which is part of the normal app bundle) could never
  // render in the first place. Only /api/* beyond the allow-list above is
  // actually blocked.
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const { enabled } = await getLockdownState();
  if (!enabled) {
    return next();
  }
  res.status(423).json({ error: "System is in emergency lockdown", locked: true });
}
