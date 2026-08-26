-- Which of the customer's previously-ordered products the rep found in
-- stock during an "assortment check" visit -- picked from a list built
-- from this customer's own order history (see GET
-- /customers/:id/ordered-products), not the general brand-availability
-- grid above it (that's market-wide, this is this-customer-specific).
ALTER TABLE checkins ADD COLUMN available_products TEXT[];
