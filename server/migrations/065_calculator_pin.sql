-- The app-disguise unlock code (see client/js/calculatorLock.js /
-- server/src/routes/calculatorLock.js): NULL means "admin has never set a
-- custom one, use the built-in default" -- same null-means-default
-- convention as incentive_message and the other app_settings columns.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS calculator_pin_hash TEXT;
