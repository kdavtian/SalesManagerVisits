-- A screen that did not open within a few seconds (client/public/js/shell/slowRoute.js) is reported as kind 'slow_screen' with the
-- step it waited on, so Settings > System health shows why a screen "keeps spinning" on someone's device.
ALTER TABLE client_error_log DROP CONSTRAINT IF EXISTS client_error_log_kind_check;
ALTER TABLE client_error_log ADD CONSTRAINT client_error_log_kind_check CHECK (kind IN ('error', 'unhandledrejection', 'slow_load', 'slow_screen'));
