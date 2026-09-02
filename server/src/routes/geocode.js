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
  // Nominatim's address breakdown -- state is Armenia's marz (e.g.
  // "Yerevan", "Shirak"), suburb/city_district is a Yerevan district
  // (e.g. "Ajapnyak"), city/town is a marz's city for anywhere else. The
  // client maps these onto the fixed region/subregion lists rather than
  // trusting arbitrary OSM naming, since Nominatim's exact field per area
  // varies.
  res.json({
    address: data.display_name || null,
    region: data.address?.state || null,
    subregion: data.address?.suburb || data.address?.city_district || data.address?.city || data.address?.town || null,
  });
});

// Forward geocoding for the address-search fallback in the location picker
// (map.js) -- lets a rep type a customer's address and drop the pin there
// instead of relying on GPS. Same provider/rate-limit shape as /reverse.
// Biased to Armenia (countrycodes=am) since every customer is local; still
// returns whatever Nominatim finds if nothing local matches.
geocodeRouter.get("/search", geocodeLimiter, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q || q.length < 3) {
    return res.status(400).json({ error: "q must be at least 3 characters" });
  }

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=am&addressdetails=1&limit=5`;
  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "KAD-Motors-FieldVisits/1.0 (internal field sales app)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return res.status(502).json({ error: "Address search failed" });
  }
  if (!response.ok) {
    return res.status(502).json({ error: "Address search failed" });
  }

  const data = await response.json();
  res.json(
    data.map((item) => ({
      address: item.display_name,
      lat: Number(item.lat),
      lng: Number(item.lon),
      region: item.address?.state || null,
      subregion: item.address?.suburb || item.address?.city_district || item.address?.city || item.address?.town || null,
    }))
  );
});
