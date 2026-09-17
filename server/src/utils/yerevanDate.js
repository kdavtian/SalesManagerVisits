// Armenia has stayed at a fixed UTC+4 offset (no DST) since 2011's DST
// exemption -- safe to hardcode rather than pull in a timezone library for
// what's otherwise a one-line offset. Any endpoint that defaults a date
// filter to "today"/"this month" needs to reason in *this* calendar, not
// the server process's own timezone or raw UTC: near midnight UTC (roughly
// 20:00-24:00 UTC, i.e. the small hours in Yerevan), `new Date()` and its
// local getters/toISOString() both still read as the previous calendar day
// here -- a default that's meant to mean "today" for the business quietly
// means "yesterday" for a chunk of every day.
const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;

function yerevanNow(now = new Date()) {
  return new Date(now.getTime() + YEREVAN_OFFSET_MS);
}

// "YYYY-MM-DD" for the current Yerevan calendar date.
export function yerevanToday(now = new Date()) {
  return yerevanNow(now).toISOString().slice(0, 10);
}

// "YYYY-MM-01" for the current Yerevan calendar month.
export function yerevanMonthStart(now = new Date()) {
  const shifted = yerevanNow(now);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKey(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// The exact UTC instant that a given Yerevan calendar date's midnight
// falls at -- the one place this file's fixed +4h offset gets applied in
// reverse (local date -> UTC instant, rather than instant -> local date
// like every function above it). Every bonus period boundary is built from
// this, so a challenge round's stored TIMESTAMPTZ bounds are always exactly
// "Yerevan midnight", never off by the offset in either direction.
function yerevanMidnightUtc(dateStr) {
  return new Date(`${dateStr}T00:00:00.000+04:00`);
}

// Inclusive start / exclusive end (the next Yerevan midnight) as real UTC
// Date instants -- the shape every period-boundary helper below returns,
// and the shape a challenge round's start_at/end_at columns store. A
// half-open range (`>= start AND < end`) is deliberate: it composes
// correctly across days/weeks/months without a special "end of day"
// off-by-one, and matches how every other date-range query in this app
// already works.
function boundsFor(startDateStr, endDateStr) {
  return { startAt: yerevanMidnightUtc(startDateStr), endAt: yerevanMidnightUtc(endDateStr) };
}

// Today's bounds, in the Yerevan calendar -- a "daily" challenge round.
export function yerevanDayBounds(now = new Date()) {
  const start = yerevanToday(now);
  const shifted = yerevanNow(now);
  const next = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1));
  const end = dateKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return boundsFor(start, end);
}

// Monday-Sunday, per the brief's explicit rule (never a rolling 7-day
// window). getUTCDay() is 0=Sunday..6=Saturday; converting to an
// ISO-style 1=Monday..7=Sunday makes "days since Monday" a plain
// subtraction instead of a special case for Sunday.
export function yerevanWeekBounds(now = new Date()) {
  const shifted = yerevanNow(now);
  const isoDow = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  const monday = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - (isoDow - 1)));
  const nextMonday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7));
  return boundsFor(
    dateKey(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
    dateKey(nextMonday.getUTCFullYear(), nextMonday.getUTCMonth() + 1, nextMonday.getUTCDate())
  );
}

// Calendar month, not a rolling 30 days.
export function yerevanMonthBounds(now = new Date()) {
  const start = yerevanMonthStart(now);
  const shifted = yerevanNow(now);
  const nextMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1));
  const end = dateKey(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 1);
  return boundsFor(start, end);
}

// Calendar year.
export function yerevanYearBounds(now = new Date()) {
  const shifted = yerevanNow(now);
  const y = shifted.getUTCFullYear();
  return boundsFor(dateKey(y, 1, 1), dateKey(y + 1, 1, 1));
}

// A custom "5-10 May" round: both dates are inclusive per the brief, so the
// exclusive end is the day *after* endDateStr, in Yerevan. Computed as a
// straight 24h addition to endDateStr's own Yerevan midnight instant
// (Armenia has no DST, so this is always exactly one calendar day later) --
// deliberately NOT round-tripped back through a "YYYY-MM-DD" string and
// re-parsed, which would silently re-derive the date from the instant's
// UTC calendar day instead of its Yerevan one and land a day short.
export function yerevanCustomRangeBounds(startDateStr, endDateStr) {
  const startAt = yerevanMidnightUtc(startDateStr);
  const endAt = new Date(yerevanMidnightUtc(endDateStr).getTime() + 24 * 60 * 60 * 1000);
  return { startAt, endAt };
}

// Which Yerevan calendar date a UTC instant (e.g. a checkin's `timestamp`,
// an order's `created_at`) falls on -- the inverse of yerevanMidnightUtc,
// and what every "attribute this activity to its occurrence date" rule in
// the brief needs. Returns the same "YYYY-MM-DD" shape as yerevanToday.
export function yerevanDateOf(instant) {
  return yerevanToday(instant instanceof Date ? instant : new Date(instant));
}

// "HH:MM:SS" for the Yerevan-local time of day a UTC instant falls at --
// lexicographically comparable to a Postgres TIME column value (node-pg
// returns TIME as the same "HH:MM:SS" string), which is what the office
// attendance cutoff/earliest-time comparisons in bonusSourceIngest.js need.
export function yerevanTimeOfDay(instant) {
  const shifted = yerevanNow(instant instanceof Date ? instant : new Date(instant));
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

// ISO day-of-week (1=Monday..7=Sunday) for the Yerevan calendar date a UTC
// instant falls on -- what the office attendance "workdays" restriction
// compares against.
export function yerevanIsoDayOfWeek(instant) {
  const shifted = yerevanNow(instant instanceof Date ? instant : new Date(instant));
  const dow = shifted.getUTCDay();
  return dow === 0 ? 7 : dow;
}
