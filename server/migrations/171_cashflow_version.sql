-- The Excel cashflow (payments) lines get the same version number as the order lines (migration 168): every statement that changes
-- them raises it, and the server's copy of them (money/cashflowCopy.js) is read again only then.
DROP TRIGGER IF EXISTS erp_cashflow_lines_version ON erp_cashflow_lines;
CREATE TRIGGER erp_cashflow_lines_version AFTER INSERT OR UPDATE OR DELETE ON erp_cashflow_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bump_data_version();
DROP TRIGGER IF EXISTS erp_cashflow_lines_version_truncate ON erp_cashflow_lines;
CREATE TRIGGER erp_cashflow_lines_version_truncate AFTER TRUNCATE ON erp_cashflow_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bump_data_version();

INSERT INTO data_versions (table_name, version) VALUES ('erp_cashflow_lines', 1) ON CONFLICT DO NOTHING;
