-- Admin-configurable Home "Quick actions" tiles, per role.
-- Shape: { "<role>": ["qa_check_in", "qa_plan_route", ...], ... } -- an
-- explicit allow-list of quick-action ids per role. NULL (never configured)
-- or a role simply absent from the object means "use the built-in default
-- visibility for that role", so existing installs keep today's behavior
-- until an admin actively customizes it.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS quick_action_visibility JSONB;
