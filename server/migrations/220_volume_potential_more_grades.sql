-- Customer potential: three grades our customers buy that the catalogue had no line for (owner, 2026-11-20, from the "no catalogue line"
-- list: Magnatec / Orlen / Royal 5W-20, Edge / Royal 0W-40, Vecton LD 10W-30 drums). The other four grades of that list are counted under
-- the closest line by the rules (volumeActuals.js GRADE_INTO): 0W-8 -> 0W-16, 10W-60 -> 10W-40, car 10W-30 -> 5W-30, truck 20W-50 -> 15W-40.
-- Additive; a line already there (added by hand in Settings) is kept as it is.
INSERT INTO volume_potential_lines (code, group_key, name_en, name_hy, unit, castrol_hint, sort_order) VALUES
  ('pcmo_0w40', 'pcmo', 'PCMO 0W-40', 'Մարդատար շարժիչի յուղ 0W-40', 'L', 'EDGE', 35),
  ('pcmo_5w20', 'pcmo', 'PCMO 5W-20', 'Մարդատար շարժիչի յուղ 5W-20', 'L', 'MAGNATEC', 38),
  ('hdeo_10w30', 'hdeo', 'HDEO 10W-30', 'Ծանր տեխնիկայի յուղ 10W-30', 'L', 'VECTON', 75)
ON CONFLICT (code) DO NOTHING;
