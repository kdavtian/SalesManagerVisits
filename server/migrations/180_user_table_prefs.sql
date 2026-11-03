-- Desktop tables, per person (owner, 2026-11-03): which columns, in which order, and whether the widths follow the content. Saved on the
-- server so the MacBook and the Windows PC show the same table. One row per person and table (page key); config is small JSON
-- { order: [column keys], on: [visible keys], fit: boolean }. Added only: old clients keep their own copy in the browser.
CREATE TABLE IF NOT EXISTS user_table_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key   TEXT    NOT NULL CHECK (char_length(page_key) BETWEEN 1 AND 60),
  config     JSONB   NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_key)
);
