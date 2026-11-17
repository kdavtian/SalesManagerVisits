// A write sent from the offline queue arrives minutes or hours after the rep pressed Save: its captured_at is that moment, not the moment the
// server heard about it. Accepted only when plausible -- not in the future, not older than a week -- so a wrong phone clock cannot rewrite
// history. Used by check-ins and the customer volume potential.
export function parseCapturedAt(value, now = Date.now()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t) || t > now + 5 * 60 * 1000 || t < now - 7 * 24 * 60 * 60 * 1000) return null;
  return new Date(t).toISOString();
}
