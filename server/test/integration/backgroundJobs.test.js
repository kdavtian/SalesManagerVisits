// The one background job scheduler (docs/architecture-roadmap.md, step 4; server/src/jobs/): a due job runs once even with two server
// copies, a failure is recorded, a job still running is not started again, a switched-off job never runs, and the registry is complete.
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { createScheduler, jobStatus, jobTimeoutMs } from "../../src/jobs/scheduler.js";
import { currentPoolKind, useWebLimits, endPools } from "../../src/db/pool.js";
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
  await endPools(); // both connection groups (one test switches the web limits on)
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

// Improvement plan 0.22: a hung run is cut at its time limit (marked failed, slot freed, its signal aborted); 3 failures in a row or a run
// still going after 3 intervals sends one Telegram line per job per day; a good run resets the count.
test("a run past its time limit is marked failed and its signal aborted; it is not started again until it really ends", async () => {
  let signal;
  let calls = 0;
  let release;
  const j = job(`itest-timeout-${process.pid}`, (_now, ctx) => {
    calls++;
    signal = ctx.signal;
    return new Promise((r) => (release = r)); // hangs (does not read its signal)
  }, { timeoutMs: 150 });
  const s = createScheduler([j], { log: quiet, alert: async () => {} });
  await s.tick();
  await makeDue(j.name);
  assert.equal(await s.tick(), 1, "the tick returns although the run never finishes");
  assert.equal(signal.aborted, true);
  let row = await rowOf(j.name);
  assert.equal(row.last_ok, false);
  assert.match(row.last_error, /timed out/);
  assert.equal(row.failures_in_a_row, 1);
  assert.deepEqual(s.running(), [j.name], "the hung run still holds its slot");
  await makeDue(j.name);
  assert.equal(await s.tick(), 0, "never two copies of the same job side by side");
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.running(), [], "the slot is free once the run really ended");
  assert.equal(await s.tick(), 1, "and the job runs again");
  assert.equal(calls, 2);
  release();
});

test("the default time limit: 3 intervals, between 10 and 60 minutes", () => {
  const MIN = 60 * 1000;
  assert.equal(jobTimeoutMs({ everyMs: MIN }), 10 * MIN);
  assert.equal(jobTimeoutMs({ everyMs: 10 * MIN }), 30 * MIN);
  assert.equal(jobTimeoutMs({ everyMs: 3 * 60 * MIN }), 60 * MIN);
  assert.equal(jobTimeoutMs({ everyMs: MIN, timeoutMs: 5 }), 5);
});

test("3 failures in a row send one admin line; no second line the same day; a good run resets the count", async () => {
  const sent = [];
  let fail = true;
  const j = job(`itest-alert-${process.pid}`, async () => {
    if (fail) throw new Error("db <down>");
  });
  const s = createScheduler([j], { log: quiet, alert: async (text) => void sent.push(text) });
  await s.tick();
  for (let i = 0; i < 2; i++) {
    await makeDue(j.name);
    await s.tick();
  }
  assert.equal(sent.length, 0, "2 failures: no alert yet");
  await makeDue(j.name);
  await s.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`${j.name}: failed 3 runs in a row`));
  assert.match(sent[0], /db &lt;down&gt;/, "the error is escaped for Telegram HTML");
  await makeDue(j.name);
  await s.tick();
  assert.equal(sent.length, 1, "at most once a day per job");
  fail = false;
  await makeDue(j.name);
  await s.tick();
  const row = await rowOf(j.name);
  assert.equal(row.failures_in_a_row, 0);
  assert.equal(row.failures, 4);
  const [status] = await jobStatus([j]);
  assert.equal(status.failures_in_a_row, 0);
});

test("a run still going after 3 of its intervals sends one admin line", async () => {
  const sent = [];
  let release;
  const j = job(`itest-stuck-${process.pid}`, () => new Promise((r) => (release = r)), { everyMs: 1000, timeoutMs: 60_000 });
  const s = createScheduler([j], { log: quiet, alert: async (text) => void sent.push(text) });
  await s.tick();
  await makeDue(j.name);
  const first = s.tick();
  await new Promise((r) => setTimeout(r, 3600));
  await s.tick();
  await s.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /still running after/);
  release();
  await first;
});

test("jobs run on the long database connections even in the web server; stop() lets no new run start and waits for the running one", async () => {
  useWebLimits(true);
  try {
    assert.equal(currentPoolKind(), "web");
    let kind;
    let release;
    let runs = 0;
    const j = job(`itest-kind-${process.pid}`, () => {
      runs++;
      kind = currentPoolKind();
      return new Promise((r) => (release = r));
    });
    const s = createScheduler([j], { log: quiet });
    await s.tick();
    await makeDue(j.name);
    const ticking = s.tick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kind, "long");
    let stopped = false;
    const stopping = s.stop(5000).then((left) => {
      stopped = true;
      return left;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stopped, false, "stop waits for the run in progress");
    release();
    assert.equal(await stopping, 0);
    await ticking;
    assert.equal((await rowOf(j.name)).last_ok, true, "its result was saved before stop() resolved");
    await makeDue(j.name);
    assert.equal(await s.tick(), 0, "no new run after stop()");
    assert.equal(runs, 1);
  } finally {
    useWebLimits(false);
  }
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
