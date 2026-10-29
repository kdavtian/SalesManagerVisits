-- Each person's own order of the Home screen buttons (owner, 2026-10-29: "let user rearrange home buttons in his settings").
-- NULL = the standard order (client/public/js/quickActions.js QUICK_ACTIONS). Which buttons a role sees is still the admin's
-- choice (settings quick_action_visibility); this only orders them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_tile_order TEXT[];
