-- Viscosity read from a product name only when it stands on its own (CI, 2026-11-19): migration 216 took the first "digit W digit" anywhere,
-- so a code inside a name ("Zz3w2k EDGE 5W-30") gave "3W-2". Now the grade may not touch a letter or digit before it, nor a digit after it
-- ("EDGE 5W-30", "MAGNATEC 10W40 A3/B4", "0W20" match; "AB3W2", "15W400X" do not). Re-reads every product whose value was not typed by hand.
CREATE OR REPLACE FUNCTION viscosity_of_name(name TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  -- "05W-30" is 5W-30 (a leading zero dropped; "0W-20" keeps its zero)
  SELECT regexp_replace(upper(regexp_replace(
           substring(name from '(?<![[:alnum:]])([0-9]{1,2}[[:space:]]*[Ww][[:space:]]*-?[[:space:]]*[0-9]{1,2})(?![0-9])'),
           '[[:space:]]*[Ww][[:space:]]*-?[[:space:]]*', 'W-')), '^0([0-9])W', '\1W')
$$;

UPDATE products SET viscosity = viscosity_of_name(name)
WHERE NOT viscosity_manual AND viscosity IS DISTINCT FROM viscosity_of_name(name);
