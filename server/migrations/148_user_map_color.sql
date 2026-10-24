-- Each sales team member can have a colour (owner, 2026-10-24): "Colour by Rep" on the map draws a ring of that colour around the pins of the rep's customers.
-- NULL = not chosen: the app picks a stable colour from its palette.
ALTER TABLE users ADD COLUMN IF NOT EXISTS map_color TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_map_color_check;
ALTER TABLE users ADD CONSTRAINT users_map_color_check CHECK (map_color IS NULL OR map_color ~ '^#[0-9a-f]{6}$');
