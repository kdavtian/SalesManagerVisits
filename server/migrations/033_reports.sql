-- 1 point per new customer a rep adds, alongside the existing visit/photo
-- points -- rewards finding new opportunities, not just working the
-- existing book.
ALTER TABLE monthly_points_closeouts ADD COLUMN customer_points INTEGER NOT NULL DEFAULT 0;

-- Per-role access to each named report (see REPORTS in server/src/reports.js).
-- No row for a role/report pair means "use the report's own default" (set
-- in code, not the database) -- admin only needs to write a row here to
-- override that default. enabled=false is a real override (hide a report
-- a role would otherwise default to seeing), not just "no grant".
CREATE TABLE report_access (
  report_key TEXT NOT NULL,
  role TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (report_key, role)
);
