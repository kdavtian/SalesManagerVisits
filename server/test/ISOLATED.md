# Isolated tests

`isolated-tests.txt` lists the test files that change or read state EVERY other test can see:
- the single `app_settings.bonuses_enabled` switch (ten bonus files: search `setBonusesEnabled` / `bonuses_enabled`),
- lockdown (locks every request), the ERP sync (TRUNCATEs `erp_customer_data`), the route-plan sets (one global active plan rewrites every
  rep's rules), Vaghinak's engine tick (scans the whole database),
- company-wide totals read as a before/after difference (`dashboardKpis.test.js`: the Home KPIs sum every order line of the month, so
  another file adding a line at the same moment changed the difference; CI 2026-10-28).
- the automatic-task runs over the whole database (`taskAutoComplete.test.js`: its debt task is created with the OLDEST sales director as
  creator, which can be another file's temporary user; `tasks.creator_id` is ON DELETE CASCADE, so that file's clean-up deleted the task
  and the test found none; local CI 2026-10-29). `debtCollectionTasks.test.js` the same way: its tasks go to "the sales director" of the
  whole database, which can be another file's temporary user deleted mid-run (`tasks_creator_id_fkey` errors, CI on PR #519).

They never share a database with other files: `scripts/run-isolated.sh` gives EACH listed file a fresh database of its own (migrated, dropped
again after a pass, kept after a failure) and runs five at a time, so they neither disturb nor wait for anybody; the time is that of the slowest
file. The test code is unchanged. CI (`.github/workflows/ci.yml`, job `isolated`) and `scripts/local-ci.sh` both read this one list, and the shards
run every test file that is NOT in it.

Adding a test that does one of these things? Put it in the list. A failure that appears in only ONE place, with a foreign-key error or a wrong
count that no other run shows, is almost always this: find what global state it touches and list the file; never skip the test.
