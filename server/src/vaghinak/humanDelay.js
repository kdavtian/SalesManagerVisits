// Vaghinak should not speak at the exact minute a rule becomes true (owner, 2026-10-18: "not started at 10:30 and he
// asks at strictly 10:31 -- not human. Make it random between 10:30 and 10:35"). The first time something is due, a
// random delay (0 .. maxMs) is drawn and remembered; the message goes out once that moment has passed. Kept in memory
// only: a restart simply draws a fresh delay, and the unique key of the message itself still prevents duplicates.
export const HUMAN_DELAY_MAX_MS = 5 * 60 * 1000;

const dueAt = new Map(); // key -> { day, at }

export function humanDelayPassed(day, key, now, { maxMs = HUMAN_DELAY_MAX_MS, pick = Math.random } = {}) {
  if (!(maxMs > 0)) return true;
  const full = `${day}|${key}`;
  let entry = dueAt.get(full);
  if (!entry) {
    if (dueAt.size > 400) for (const [k, v] of dueAt) if (v.day !== day) dueAt.delete(k);
    entry = { day, at: now.getTime() + Math.floor(pick() * maxMs) };
    dueAt.set(full, entry);
  }
  return now.getTime() >= entry.at;
}

// Background jobs that look at the whole company (chasers) run at an irregular rhythm too: next run 3..7 minutes later.
const nextRun = new Map();
export function jitteredDue(key, now, { pick = Math.random } = {}) {
  const next = nextRun.get(key);
  if (next !== undefined && now.getTime() < next) return false;
  nextRun.set(key, now.getTime() + Math.round((3 + pick() * 4) * 60 * 1000));
  return true;
}
