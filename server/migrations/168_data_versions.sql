-- A version number per table, raised by every statement that changes the table (insert, update, delete, truncate).
-- The server keeps a ready copy of what it reads from big, rarely changing tables (the Excel order lines: tens of thousands of rows,
-- replaced once a day by the ERP sync) and reads only this one row to know whether its copy is still current.
CREATE TABLE IF NOT EXISTS data_versions (
  table_name TEXT PRIMARY KEY,
  version    BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION bump_data_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO data_versions (table_name, version) VALUES (TG_TABLE_NAME, 1)
  ON CONFLICT (table_name) DO UPDATE SET version = data_versions.version + 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS erp_order_lines_version ON erp_order_lines;
CREATE TRIGGER erp_order_lines_version AFTER INSERT OR UPDATE OR DELETE ON erp_order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bump_data_version();
DROP TRIGGER IF EXISTS erp_order_lines_version_truncate ON erp_order_lines;
CREATE TRIGGER erp_order_lines_version_truncate AFTER TRUNCATE ON erp_order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION bump_data_version();

INSERT INTO data_versions (table_name, version) VALUES ('erp_order_lines', 1) ON CONFLICT DO NOTHING;
