-- How long a tap takes to become a screen, measured on the real phones (owner, 2026-11-04: "measure every tap"; client/public/js/kit/navTiming.js).
-- Only the screen's kind ("#/customers/:id", never an id or a search text), the time in ms, the kind of sample (nav = tap to screen, inp = a slow
-- interaction the browser reported), the role and the kind of device. Kept 30 days (jobs: nav-timing-retention).
CREATE TABLE IF NOT EXISTS nav_timings (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  route TEXT NOT NULL,
  ms INTEGER NOT NULL CHECK (ms >= 0 AND ms <= 15000),
  kind TEXT NOT NULL CHECK (kind IN ('nav', 'inp')),
  role TEXT,
  device TEXT NOT NULL DEFAULT 'phone' CHECK (device IN ('phone', 'tablet', 'desktop'))
);
CREATE INDEX IF NOT EXISTS nav_timings_at_idx ON nav_timings (at);
