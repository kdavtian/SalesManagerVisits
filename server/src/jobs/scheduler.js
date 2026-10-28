// The one scheduler for background jobs (docs/architecture-roadmap.md, step 4). Every job keeps its own cadence (`everyMs`); one timer
// ticks every TICK_MS and runs what is due. A job is claimed in the database (background_jobs.next_run_at moved forward in one UPDATE),
// so when two server copies run, only one of them runs each turn; a job still running in this process is not started again. Each run's
// result (ok / error, duration) is written back for Settings > System health.
import { pool } from "../db/pool.js";

export const TICK_MS = 15 * 1000;

// jobs: [{ name, everyMs, run: async (now) => void, enabled?: () => boolean, why?: string }]
export function createScheduler(jobs, { db = pool, tickMs = TICK_MS, log = console } = {}) {
  const running = new Set();
  let timer = null;
  let registered = null;

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

  async function runJob(job, now) {
    running.add(job.name);
    const t0 = Date.now();
    let error = null;
    try {
      await job.run(now);
    } catch (err) {
      error = err;
      log.error(`Background job ${job.name} failed:`, err.message);
    } finally {
      running.delete(job.name);
    }
    await db
      .query(
        `UPDATE background_jobs SET last_finished_at = now(), last_ok = $2::boolean, last_error = $3, last_duration_ms = $4::int,
                runs = runs + 1, failures = failures + CASE WHEN $2::boolean THEN 0 ELSE 1 END
         WHERE name = $1`,
        [job.name, !error, error ? String(error.message).slice(0, 500) : null, Date.now() - t0]
      )
      .catch((err) => log.error(`Background job ${job.name}: result not saved:`, err.message));
  }

  // One turn: claim every due job in one UPDATE and start the claimed ones side by side.
  async function tick(now = new Date()) {
    if (!registered) registered = register();
    await registered;
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
    await Promise.all(jobs.filter((job) => claimed.has(job.name)).map((job) => runJob(job, now)));
    return claimed.size;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((err) => log.error("Background jobs tick failed:", err.message));
    }, tickMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, register: () => (registered = register()) };
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
    };
  });
}
