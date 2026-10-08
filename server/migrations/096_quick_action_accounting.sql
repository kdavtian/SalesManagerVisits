-- New "Accounting" Home quick action. A role whose tile list an admin already
-- saved would not get it (a saved list replaces the defaults), so add it to
-- every non-empty saved list. Empty lists ("no tiles on purpose") stay empty.
UPDATE app_settings
SET quick_action_visibility = (
  SELECT jsonb_object_agg(
    key,
    CASE
      WHEN jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0 AND NOT (value ? 'qa_accounting')
        THEN value || '["qa_accounting"]'::jsonb
      ELSE value
    END
  )
  FROM jsonb_each(quick_action_visibility)
)
WHERE quick_action_visibility IS NOT NULL
  AND jsonb_typeof(quick_action_visibility) = 'object'
  AND quick_action_visibility <> '{}'::jsonb;
