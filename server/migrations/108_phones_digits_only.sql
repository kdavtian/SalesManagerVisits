-- Phones are stored as digits only: +37491007019 (shown as +374 91 007 019). Armenian numbers typed in
-- any older shape (091007019, 91-007-019, +374 91 007019, ...) are rewritten; foreign numbers and
-- free text are left alone.
UPDATE customers SET phone = '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8)
WHERE phone IS NOT NULL
  AND regexp_replace(phone, '\D', '', 'g') ~ '^(374[0-9]{8}|0[0-9]{8}|[0-9]{8})$'
  AND phone <> '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8);

UPDATE users SET phone = '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8)
WHERE phone IS NOT NULL
  AND regexp_replace(phone, '\D', '', 'g') ~ '^(374[0-9]{8}|0[0-9]{8}|[0-9]{8})$'
  AND phone <> '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8);

UPDATE company_profile SET phone = '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8)
WHERE phone IS NOT NULL
  AND regexp_replace(phone, '\D', '', 'g') ~ '^(374[0-9]{8}|0[0-9]{8}|[0-9]{8})$'
  AND phone <> '+374' || right(regexp_replace(phone, '\D', '', 'g'), 8);
