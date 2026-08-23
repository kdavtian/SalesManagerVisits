import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";

export const geocodeRouter = Router();
geocodeRouter.use(requireAuth);

// Nominatim's usage policy requires a real User-Agent identifying the app
// and caps free usage at ~1 request/second -- this endpoint is only hit
// once per "drop a pin" action (a human action, not a bulk job), so a
// generous per-user limit is enough to stay well within that.
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many location lookups. Try again in a moment." },
});

geocodeRouter.get("/reverse", geocodeLimiter, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat and lng are required" });
  }

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "KAD-Motors-FieldVisits/1.0 (internal field sales app)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return res.status(502).json({ error: "Address lookup failed" });
  }
  if (!response.ok) {
    return res.status(502).json({ error: "Address lookup failed" });
  }

  const data = await response.json();
  res.json({ address: data.display_name || null });
});
