-- Customer addresses (owner, 2026-10-27): drop the trailing country ("..., Հայաստան") the map's address lookup used to add. Every customer is in
-- Armenia; new addresses come without it (routes/geocode.js withoutCountry).
UPDATE customers
SET address = NULLIF(btrim(regexp_replace(address, '(,\s*(Հայաստան|Armenia|Армения))+\s*$', '', 'i')), '')
WHERE address ~* ',\s*(Հայաստան|Armenia|Армения)\s*$';
