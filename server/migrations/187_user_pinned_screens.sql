-- Each person's pinned screens (owner, 2026-11-04: "pinned screens"): up to 4 screen ids, first one first, shown at the top of Home and of the
-- desktop sidebar. NULL / empty = nothing pinned. Which screens may be pinned is checked by the server against what the role may open
-- (client/public/js/shared/screens.js); this column only remembers the choice. Backward compatible: older apps never read it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pinned_screens TEXT[];
