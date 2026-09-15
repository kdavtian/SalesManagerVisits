// Double-submit-cookie CSRF protection (improvement list 8.1) for the
// cookie-authenticated session. The session cookie itself is httpOnly +
// sameSite=lax, which already blocks it from riding a cross-site POST in
// current browsers, and every JSON-only route is further protected by the
// lack of any CORS policy (see app.js) -- there's no simple cross-site
// request that can both carry the cookie and hit a JSON-gated route today.
// This is defense-in-depth on top of that, and the one thing sameSite
// alone doesn't cover: the multipart upload routes (checkins, delivery
// signature, avatar/product images), which a plain cross-site <form> CAN
// submit as a "simple request" with no CORS preflight.
import crypto from "node:crypto";

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function issueCsrfToken(res) {
  const token = crypto.randomBytes(24).toString("hex");
  // Deliberately NOT httpOnly -- the client has to be able to read this
  // cookie itself to echo it back in the header (see api.js's request()).
  // That's the point of the double-submit pattern: a cross-site attacker
  // can cause the cookie to be sent, but (with no CORS policy allowing it)
  // can't read the cookie's value to also set the matching header.
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearCsrfToken(res) {
  res.clearCookie(CSRF_COOKIE);
}

// Only applies to requests that are actually riding the session cookie --
// login/register have no session cookie yet, and the ERP bot's sync
// endpoint authenticates with a bearer key (ERP_SYNC_KEY), not a cookie,
// so neither needs (or could supply) a CSRF token.
//
// Login itself is always exempt, regardless of whether a `session` cookie
// happens to be present: a stale/expired JWT left over from a previous
// install (token_version bumped, JWT_SECRET rotated, or it just expired)
// still counts as "a session cookie is present" for the check below, but
// the device was never issued a matching csrf_token for it -- gating login
// on that turned an expired cookie into a permanent "Missing or invalid
// CSRF token" lockout screen with no way for the user to recover short of
// manually clearing cookies, since the login form itself has no CSRF token
// to send yet.
export function requireCsrf(req, res, next) {
  if (req.path === "/api/auth/login") return next();
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (!req.cookies?.session) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "Missing or invalid CSRF token" });
  }
  next();
}
