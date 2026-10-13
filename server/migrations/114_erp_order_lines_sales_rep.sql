-- The selling channel (ORDERS "Sales_Rep") of each order line, as the workbook has it: the channel that made
-- the sale, which differs from the customer's home channel on about a quarter of the lines. Needed by the
-- Products & liters report ("how much Royal 0W-8 did SM YVN / CVO sell"). Filled by the bot's next sync;
-- until then the report falls back to the customer's channel. Index for date-range scans of the report.
ALTER TABLE erp_order_lines ADD COLUMN IF NOT EXISTS sales_rep TEXT;
CREATE INDEX IF NOT EXISTS idx_erp_order_lines_date ON erp_order_lines (order_date);
