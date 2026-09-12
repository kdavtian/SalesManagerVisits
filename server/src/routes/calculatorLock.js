import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { getCalculatorPinHash } from "../settings.js";

export const calculatorLockRouter = Router();

// Deliberately unauthenticated -- this runs before the disguised app has
// shown any login screen at all, let alone signed anyone in. The keyspace
// is small (a PIN, not a password), so the rate limit is the actual
// protection against brute force, not the hash comparison itself.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { unlocked: false },
});

// Bcrypt hash of "1997" -- the documented out-of-the-box code (see
// CLAUDE.md / the feature's own spec) for an install where an admin has
// never set their own via Settings. Precomputed rather than hashed at
// request time so an unconfigured install never pays bcrypt's cost on
// every single wrong-guess request.
const DEFAULT_PIN_HASH = "$2a$10$lHvCa6YrmqIK.3jNhmTBgeiezX.Umkinz.QPGPIc6jz6t25MHfOpO";

calculatorLockRouter.post("/verify", verifyLimiter, async (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== "string" || !code) {
    return res.status(400).json({ unlocked: false });
  }
  const hash = (await getCalculatorPinHash()) || DEFAULT_PIN_HASH;
  const matches = await bcrypt.compare(code, hash);
  if (!matches) {
    return res.status(401).json({ unlocked: false });
  }
  res.json({ unlocked: true });
});
