# Isolated tests

`isolated-*.txt` list the test files that change or read state EVERY other test can see, so they never run next to the others:
each list gets its own database and runs one file after the other (`--test-concurrency=1`), in parallel with the other list and with the shards.
CI (`.github/workflows/ci.yml`) and `scripts/local-ci.sh` both read these files, so there is one list to keep.

- `isolated-bonus.txt`: every file that flips or asserts on the single `app_settings.bonuses_enabled` switch (search `setBonusesEnabled` / `bonuses_enabled`).
- `isolated-other.txt`: lockdown (locks every request), the ERP sync (TRUNCATEs `erp_customer_data`), the route-plan sets (one global active plan rewrites every rep's rules), Vaghinak's engine tick (scans the whole database).

Adding a test that does one of these things? Put it in the matching list. A failure that appears in only ONE shard, with a foreign-key error or a wrong
count that no other run shows, is almost always this: find what global state it touches and isolate the file; never skip the test.
