// The one background job scheduler (docs/architecture-roadmap.md, step 4; server/src/jobs/): a due job runs once even with two server
// copies, a failure is recorded, a job still running is not started again, a switched-off job never runs, and the registry is complete.
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { createScheduler, jobStatus } from "../../src/jobs/scheduler.js";
import { JOBS } from "../../src/jobs/index.js";
import en from "../../../client/public/js/i18n-en.js";
import hy from "../../../client/public/js/i18n-hy.js";

const quiet = { error: () => {} };
const names = [];
const job = (name, run, extra = {}) => {
  names.push(name);
  return { name, everyMs: 60 * 60 * 1000, run, ...extra };
};
const makeDue = (name) => pool.query("UPDATE background_jobs SET next_run_at = now() - interval '1 second' WHERE name = $1", [name]);
const rowOf = async (name) => (await pool.query("SELECT * FROM background_jobs WHERE name = $1", [name])).rows[0];

test.after(async () => {
  await pool.query("DELETE FROM background_jobs WHERE name = ANY($1)", [names]);
  await pool.end();
});

test("a new job waits one interval; a due job runs once, even when two server copies tick together", async () => {
  let runs = 0;
  const j = job(`itest-once-${process.pid}`, async () => void runs++);
  const a = createScheduler([j], { log: quiet });
  const b = createScheduler([j], { log: quiet });
  assert.equal(await a.tick(), 0, "not due right after the first start (like the old setInterval)");
  assert.ok(new Date((await rowOf(j.name)).next_run_at) > new Date(Date.now() + 59 * 60 * 1000));
  await makeDue(j.name);
  const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
  assert.equal(ra + rb, 1);
  assert.equal(runs, 1);
  const row = await rowOf(j.name);
  assert.equal(row.last_ok, true);
  assert.equal(row.runs, 1);
  assert.ok(new Date(row.next_run_at) > new Date(Date.now() + 59 * 60 * 1000), "the next run is one interval later");
  assert.equal(await a.tick(), 0, "not due again");
});

test("a failed run is recorded with its error; the job runs again next time", async () => {
  let calls = 0;
  const j = job(`itest-fail-${process.pid}`, async () => {
    calls++;
    throw new Error("boom");
  });
  const s = createScheduler([j], { log: quiet });
  await s.tick();
  await makeDue(j.name);
  await s.tick();
  let row = await rowOf(j.name);
  assert.equal(row.last_ok, false);
  assert.equal(row.last_error, "boom");
  assert.equal(row.failures, 1);
  await makeDue(j.name);
  await s.tick();
  row = await rowOf(j.name);
  assert.equal(calls, 2);
  assert.equal(row.failures, 2);
  const [status] = await jobStatus([j]);
  assert.equal(status.last_ok, false);
  assert.equal(status.failures, 2);
});

test("a job still running is not started a second time", async () => {
  let release;
  let started = 0;
  const j = job(`itest-slow-${process.pid}`, () => {
    started++;
    return new Promise((r) => (release = r));
  });
  const s = createScheduler([j], { log: quiet });
  await s.tick();
  await makeDue(j.name);
  const first = s.tick();
  await new Promise((r) => setTimeout(r, 100));
  await makeDue(j.name);
  assert.equal(await s.tick(), 0);
  release();
  await first;
  assert.equal(started, 1);
});

test("a switched-off job is not registered or run, and its status says why", async () => {
  let runs = 0;
  const j = job(`itest-off-${process.pid}`, async () => void runs++, { enabled: () => false, why: "push off" });
  const s = createScheduler([j], { log: quiet });
  assert.equal(await s.tick(), 0);
  assert.equal(await rowOf(j.name), undefined);
  const [status] = await jobStatus([j]);
  assert.equal(status.enabled, false);
  assert.equal(status.off_reason, "push off");
  assert.equal(runs, 0);
});

test("the registry: unique names, the old cadences, a label in both languages", () => {
  assert.equal(new Set(JOBS.map((j) => j.name)).size, JOBS.length);
  const every = Object.fromEntries(JOBS.map((j) => [j.name, j.everyMs / 60000]));
  assert.deepEqual(
    { vaghinak: every["vaghinak-tick"], tasks: every["task-deadline-reminders"], summary: every["daily-summary"], ops: every["ops-control"], packed: every["stale-packed-orders"], erp: every["erp-sync-freshness"], fraud: every["anti-fraud"], overdue: every["overdue-visit-reminders"] },
    { vaghinak: 1, tasks: 1, summary: 5, ops: 30, packed: 30, erp: 60, fraud: 60, overdue: 120 }
  );
  for (const j of JOBS) {
    const key = `job_${j.name.replaceAll("-", "_")}`;
    assert.ok(en[key] && hy[key], `${key} in both languages`);
    assert.equal(typeof j.run, "function");
  }
});
