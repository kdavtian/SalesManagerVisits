-- The Customers list is read in pages of 500 ordered by (name, id), each page continuing after the last name of the
-- previous one (routes/customers.js). This index lets every page start where the last one stopped instead of walking
-- the list from the top (a page at offset 39,500 cost 410 ms against 28 ms for the second page at 40,000 customers).
CREATE INDEX IF NOT EXISTS customers_name_id_idx ON customers (name, id);
