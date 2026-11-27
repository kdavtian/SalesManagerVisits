-- Drafts of Smart purchase suggestions (owner, 2026-11-27: "share button should also have option to save it as a draft and use it later").
-- One draft per supplier (as the suggestions group them): the quantities chosen on the screen, kept on the server so any purchasing person,
-- on any phone, can open it later and go on (Create purchase or Excel). Saving again for the same supplier replaces the draft.
-- lines = [{ "product_id": 12, "qty": 120 }, ...] (pieces). Not a purchase: it holds no stock, is not compared with the Excel, and nothing
-- else reads it.
CREATE TABLE IF NOT EXISTS purchase_suggestion_drafts (
  id           SERIAL PRIMARY KEY,
  supplier     TEXT NOT NULL DEFAULT '',
  lines        JSONB NOT NULL,
  lead_days    INTEGER,
  cover_days   INTEGER,
  products     INTEGER NOT NULL DEFAULT 0,
  pieces       NUMERIC(14, 3) NOT NULL DEFAULT 0,
  total_usd    NUMERIC(14, 2),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_suggestion_drafts_supplier_key ON purchase_suggestion_drafts (lower(btrim(supplier)));
