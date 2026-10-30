-- The Stock count Home tile (qa_stock_count) is added to every role that has it by default (admin, ceo, operations_director, accountant) and
-- whose Home buttons were already customized in Settings (a saved list means "only these"), so the new tile is not missing for them.
-- Roles nobody customized follow the defaults in quickActions.js and need nothing; an empty saved list ("no tiles" on purpose) stays empty. Safe to run twice.
UPDATE app_settings
SET quick_action_visibility = (
  SELECT jsonb_object_agg(
    k,
    CASE WHEN k IN ('admin', 'ceo', 'operations_director', 'accountant') AND jsonb_typeof(v) = 'array' AND jsonb_array_length(v) > 0 AND NOT v ? 'qa_stock_count'
         THEN v || '"qa_stock_count"'::jsonb ELSE v END
  )
  FROM jsonb_each(quick_action_visibility) AS e(k, v)
)
WHERE id = 1 AND quick_action_visibility IS NOT NULL AND jsonb_typeof(quick_action_visibility) = 'object' AND quick_action_visibility <> '{}'::jsonb;
