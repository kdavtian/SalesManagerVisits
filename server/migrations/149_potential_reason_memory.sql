-- The reasons a person last used for each Potential level (owner, 2026-10-24: "keep the last used reasons on the server so they follow you
-- between devices"). Filled whenever a potential classification is saved; read when the level is picked in the editor / new customer form.
-- "Other" and "counterfeit" are never remembered (see server/src/customers/potential.js).
CREATE TABLE user_potential_reason_memory (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  reasons    TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, level)
);
