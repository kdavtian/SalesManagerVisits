// The one scheduler for background jobs (docs/architecture-roadmap.md, step 4). Every job keeps its own cadence (`everyMs`); one timer
// ticks every TICK_MS and runs what is due. A job is claimed in the database (background_jobs.next_run_at moved forward in one UPDATE),
// so when two server copies run, only one of them runs each turn; a job still running in this process is not started again. Each run's
// result (ok / error, duration) is written back for Settings > System health.
//
// A job that hangs or keeps failing is reported (improvement plan 0.22): every run has a time limit (jobTimeoutMs; the run is marked failed
// and its slot freed, the job's own signal is aborted), and the admin Telegram chat gets one line per job at most once a day when it failed
// 3 runs in a row or is still running after 3 of its intervals. Jobs run on the database's "long" connections (db/pool.js runLongWork).
import { pool, runLongWork } from "../db/pool.js";
import { notifyTelegram, escapeHtml } from "../shared/telegram.js";

export const TICK_MS = 15 * 1000;
const MINUTE = 60 * 1000;
export const ALERT_AFTER_FAILURES = 3;
export const STUCK_AFTER_INTERVALS = 3;

// The time limit of one run: 3 intervals, never under 10 min (a minute job may wait on an AI or Telegram call) nor over 60 min.
// A job can set its own `timeoutMs`.
export function jobTimeoutMs(job) {
  return job.timeoutMs ?? Math.min(60 * MINUTE, Math.max(10 * MINUTE, 3 * job.everyMs));
}

const minutes = (ms) => `${Math.round(ms / MINUTE)} min`;

// jobs: [{ name, everyMs, run: async (now, { signal }) => void, enabled?: () => boolean, why?: string, timeoutMs?: number }]
export function createScheduler(jobs, { db = pool, tickMs = TICK_MS, log = console, alert = notifyTelegram } = {}) {
  const running = new Map(); // name -> { startedAt } while a run is in progress (until it ends or hits its time limit)
  const runs = new Set(); // every runJob() in progress, its result write included (what stop() waits for)
  let timer = null;
  let registered = null;
  let stopping = false;

  // First start: the row is created with its first run one interval from now (as the old setInterval did); later starts keep the stored
  // next run, so a deploy no longer pushes every job a whole interval back.
  async function register() {
    for (const job of jobs) {
      if (job.enabled && !job.enabled()) continue;
      await db.query(
        `INSERT INTO background_jobs (name, every_seconds, next_run_at) VALUES ($1, $2::int, now() + make_interval(secs => $2::int))
         ON CONFLICT (name) DO UPDATE SET every_seconds = EXCLUDED.every_seconds,
           next_run_at = LEAST(background_jobs.next_run_at, now() + make_interval(secs => EXCLUDED.every_seconds))`,
        [job.name, Math.round(job.everyMs / 1000)]
      );
    }
  }

  // One Telegram line per job per day at most; the day is claimed in the database, so two server copies never both send it.
  async function maybeAlert(job, what) {
    try {
      const { rowCount } = await db.query(
        `UPDATE background_jobs SET alerted_at = now()
         WHERE name = $1 AND (alerted_at IS NULL OR alerted_at < now() - interval '1 day')`,
        [job.name]
      );
      if (!rowCount) return false;
      await alert(`⚠️ <b>Background job problem</b>\n${escapeHtml(job.name)}: ${escapeHtml(what)}\nSettings → System health`);
      return true;
    } catch (err) {
      log.error(`Background job ${job.name}: alert not sent:`, err.message);
      return false;
    }
  }

  async function runJob(job, now) {
    const t0 = Date.now();
    const limitMs = jobTimeoutMs(job);
    const controller = new AbortController();
    let limitTimer;
    const work = Promise.resolve().then(() => job.run(now, { signal: controller.signal }));
    work.catch(() => {}); // after a timeout the run may still fail later: already counted
    const limit = new Promise((_, reject) => {
      limitTimer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${minutes(limitMs)}`));
      }, limitMs);
      limitTimer.unref?.();
    });
    const done = Promise.race([work, limit]);
    running.set(job.name, { startedAt: t0 });
    let error = null;
    try {
      await done;
    } catch (err) {
      error = err;
      log.error(`Background job ${job.name} failed:`, err.message);
    } finally {
      clearTimeout(limitTimer);
      running.delete(job.name);
    }
    const saved = await db
      .query(
        `UPDATE background_jobs SET last_finished_at = now(), last_ok = $2::boolean, last_error = $3, last_duration_ms = $4::int,
                runs = runs + 1, failures = failures + CASE WHEN $2::boolean THEN 0 ELSE 1 END,
                failures_in_a_row = CASE WHEN $2::boolean THEN 0 ELSE failures_in_a_row + 1 END
         WHERE name = $1 RETURNING failures_in_a_row`,
        [job.name, !error, error ? String(error.message).slice(0, 500) : null, Date.now() - t0]
      )
      .catch((err) => log.error(`Background job ${job.name}: result not saved:`, err.message));
    const inARow = saved?.rows?.[0]?.failures_in_a_row ?? 0;
    if (error && inARow >= ALERT_AFTER_FAILURES) {
      await maybeAlert(job, `failed ${inARow} runs in a row. Last error: ${String(error.message).slice(0, 300)}`);
    }
  }

  // A run still going after 3 of its intervals (its time limit is longer): reported once a day.
  async function checkStuck() {
    const nowMs = Date.now();
    for (const job of jobs) {
      const r = running.get(job.name);
      if (r && nowMs - r.startedAt > STUCK_AFTER_INTERVALS * job.everyMs) {
        await maybeAlert(job, `still running after ${minutes(nowMs - r.startedAt)} (runs every ${minutes(job.everyMs)})`);
      }
    }
  }

  // One turn: claim every due job in one UPDATE and start the claimed ones side by side.
  function tick(now = new Date()) {
    return runLongWork(async () => {
      if (stopping) return 0;
      if (!registered) registered = register();
      await registered;
      await checkStuck();
      if (stopping) return 0;
      const candidates = jobs.filter((job) => !running.has(job.name) && !(job.enabled && !job.enabled())).map((job) => job.name);
      if (!candidates.length) return 0;
      const { rows } = await db.query(
        `UPDATE background_jobs SET last_started_at = now(),
           next_run_at = CASE WHEN next_run_at + make_interval(secs => every_seconds) > now() THEN next_run_at + make_interval(secs => every_seconds)
                              ELSE now() + make_interval(secs => every_seconds) END
         WHERE name = ANY($1::text[]) AND next_run_at <= now() RETURNING name`,
        [candidates]
      );
      const claimed = new Set(rows.map((r) => r.name));
      await Promise.all(
        jobs
          .filter((job) => claimed.has(job.name))
          .map((job) => {
            const p = runJob(job, now).finally(() => runs.delete(p));
            runs.add(p);
            return p;
          })
      );
      return claimed.size;
    });
  }

  function start() {
    if (timer) return;
    stopping = false;
    timer = setInterval(() => {
      tick().catch((err) => log.error("Background jobs tick failed:", err.message));
    }, tickMs);
    timer.unref?.();
  }

  // No new run starts after stop(); the returned promise settles when the runs in progress finished, or after waitMs (a deploy: index.js).
  function stop(waitMs = 0) {
    clearInterval(timer);
    timer = null;
    stopping = true;
    const inFlight = [...runs];
    if (!inFlight.length || !waitMs) return Promise.resolve(inFlight.length);
    let t;
    const cap = new Promise((resolve) => {
      t = setTimeout(resolve, waitMs);
      t.unref?.();
    });
    return Promise.race([Promise.allSettled(inFlight), cap]).then(() => {
      clearTimeout(t);
      return runs.size;
    });
  }

  return { start, stop, tick, register: () => (registered = register()), running: () => [...running.keys()] };
}

// For Settings > System health: every job with its cadence and last run (a job switched off here shows why).
export async function jobStatus(jobs, db = pool) {
  const { rows } = await db.query("SELECT * FROM background_jobs");
  const byName = new Map(rows.map((r) => [r.name, r]));
  return jobs.map((job) => {
    const r = byName.get(job.name);
    const off = job.enabled && !job.enabled();
    return {
      name: job.name,
      every_seconds: Math.round(job.everyMs / 1000),
      enabled: !off,
      off_reason: off ? job.why ?? null : null,
      next_run_at: off ? null : r?.next_run_at ?? null,
      last_started_at: r?.last_started_at ?? null,
      last_finished_at: r?.last_finished_at ?? null,
      last_ok: r?.last_ok ?? null,
      last_error: r?.last_error ?? null,
      last_duration_ms: r?.last_duration_ms ?? null,
      runs: r?.runs ?? 0,
      failures: r?.failures ?? 0,
      failures_in_a_row: r?.failures_in_a_row ?? 0,
    };
  });
}
