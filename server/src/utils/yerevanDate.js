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
