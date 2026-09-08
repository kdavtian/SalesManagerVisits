-- Two things requested together: (1) reorder sales_channels to match the
-- Castrol Excel "Customers" sheet's own channel taxonomy/order, adding
-- SM B2B which existed everywhere else in the app (salesChannelAutofill.js,
-- map.js's MAP_CHANNEL_ORDER) but was never actually inserted as a row
-- here; (2) OEM/CVO/PCO are Sales-Director-owned, not run by an individual
-- field sales manager, so default their sales_channels.manager_user_id to
-- the (single) sales_director account and backfill any customer already
-- classified under those three channels the same way -- COALESCE-style,
-- only where still unset, same pattern erpSync.js already uses for
-- region/subregion autofill, so a manual correction someone already made
-- is never silently overwritten.
--
-- SM CAS (a real, distinct, already-in-use channel -- see the "Kvartal
-- Mher" fix) isn't part of the 9-channel list this ordering is based on;
-- left in place, just pushed after them, rather than deleted, since
-- dropping a channel could orphan existing targets/plans against it.

INSERT INTO sales_channels (code, name, owner_role, display_order)
SELECT 'SM B2B', 'SM B2B', 'sales_director', 35
WHERE NOT EXISTS (SELECT 1 FROM sales_channels WHERE code = 'SM B2B');

UPDATE sales_channels SET display_order = 10 WHERE code = 'SM YVN';
UPDATE sales_channels SET display_order = 20 WHERE code = 'SM Davtashen';
UPDATE sales_channels SET display_order = 30 WHERE code = 'SM Shirak';
UPDATE sales_channels SET display_order = 35 WHERE code = 'SM B2B';
UPDATE sales_channels SET display_order = 40 WHERE code = 'OEM';
UPDATE sales_channels SET display_order = 50 WHERE code = 'CVO';
UPDATE sales_channels SET display_order = 60 WHERE code = 'PCO';
UPDATE sales_channels SET display_order = 70 WHERE code = 'CAS';
UPDATE sales_channels SET display_order = 80 WHERE code = 'KF';
UPDATE sales_channels SET display_order = 90 WHERE code = 'SM CAS';

-- Only proceeds if the company has exactly one sales_director account --
-- with more than one, "the sales director" is ambiguous and this should be
-- set by hand instead of guessing.
DO $$
DECLARE
  director_id INTEGER;
BEGIN
  SELECT id INTO director_id FROM users WHERE role = 'sales_director';
  IF director_id IS NOT NULL AND (SELECT count(*) FROM users WHERE role = 'sales_director') = 1 THEN
    UPDATE sales_channels
    SET manager_user_id = COALESCE(manager_user_id, director_id)
    WHERE code IN ('OEM', 'CVO', 'PCO');

    UPDATE customers
    SET assigned_manager_id = director_id
    WHERE sales_channel IN ('OEM', 'CVO', 'PCO') AND assigned_manager_id IS NULL;
  END IF;
END $$;
