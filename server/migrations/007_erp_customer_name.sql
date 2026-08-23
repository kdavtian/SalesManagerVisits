-- Carries the customer's name through from the ERP extract, so an admin
-- linking a Field Visits customer to its ERP record can browse unlinked
-- ERP customers by name instead of guessing at raw Customer IDs.
ALTER TABLE erp_customer_data ADD COLUMN customer_name TEXT;
