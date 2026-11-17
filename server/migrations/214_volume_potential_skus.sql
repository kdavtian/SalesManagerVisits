-- Customer volume potential, phase 2 (owner, 2026-11-17): which product line each product sold (ERP order lines) belongs to, and how many
-- litres (grease: kg) one unit holds. Most products are mapped by fixed rules in code (customers/volumeActuals.js: range + viscosity grade,
-- category words); this table holds only management's own decisions -- a line for a product the rules leave unmapped, "not a potential line"
-- (filters, merch, hydraulic oil ...), or the litres of one unit when the ERP size is missing. Additive only.
CREATE TABLE IF NOT EXISTS volume_potential_sku_map (
  sku_key          TEXT PRIMARY KEY,                    -- the ERP product id, lower-case (as erp_order_lines.product_id)
  line_id          INTEGER REFERENCES volume_potential_lines(id) ON DELETE SET NULL,
  not_a_line       BOOLEAN NOT NULL DEFAULT false,      -- counted in no line (not unmapped either)
  litres_per_unit  NUMERIC(10,3),                       -- NULL = the ERP size
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (litres_per_unit IS NULL OR litres_per_unit > 0)
);

-- When the saved potential was really made on the phone (an offline save arrives later): which of two offline saves is the newer is
-- decided by this, not by when the server received it (Codex review, 2026-11-17). NULL on older rows = updated_at.
ALTER TABLE volume_potential_profiles ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
