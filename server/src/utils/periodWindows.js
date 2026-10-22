// The standard calendar periods of the period buttons (Today / This week / This month / This quarter / This year) and the
// PREVIOUS one each button flips to when it is tapped again (Yesterday / Last week / Last month / Last quarter / Last year).
// Yerevan calendar, weeks start on Monday (like date_trunc('week')). A window is { from, to } as inclusive YYYY-MM-DD dates;
// the current period ends today, a previous period is complete.
import { yerevanToday } from "./yerevanDate.js";

export const PERIOD_KEYS = ["today", "yesterday", "week", "last_week", "month", "last_month", "quarter", "last_quarter", "year", "last_year"];
// The button each previous period belongs to (tapping the selected button flips between the two).
export const PERIOD_PREVIOUS = { today: "yesterday", week: "last_week", month: "last_month", quarter: "last_quarter", year: "last_year" };

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);

export function addDays(day, n) {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

function mondayOf(day) {
  const dow = (utc(day).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

function monthEnd(y, m) {
  return fmt(new Date(Date.UTC(y, m, 0))); // day 0 of the next month
}

/** The window of a period key, or null for "all" / an unknown key. */
export function periodWindow(key, today = yerevanToday()) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const q0 = Math.floor((m - 1) / 3) * 3 + 1; // first month of this quarter
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: mondayOf(today), to: today };
    case "last_week": {
      const mon = addDays(mondayOf(today), -7);
      return { from: mon, to: addDays(mon, 6) };
    }
    case "month":
      return { from: iso(y, m, 1), to: today };
    case "last_month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: iso(py, pm, 1), to: monthEnd(py, pm) };
    }
    case "quarter":
      return { from: iso(y, q0, 1), to: today };
    case "last_quarter": {
      const pq = q0 === 1 ? 10 : q0 - 3;
      const py = q0 === 1 ? y - 1 : y;
      return { from: iso(py, pq, 1), to: monthEnd(py, pq + 2) };
    }
    case "year":
      return { from: iso(y, 1, 1), to: today };
    case "last_year":
      return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
    default:
      return null;
  }
}

/**
 * SQL condition for a timestamptz column inside a period (Yerevan days), with its two date parameters pushed on `params`.
 * `key` null/unknown -> null (no condition); an omitted key is the caller's business (reports default to "month").
 */
export function periodTimestampCondition(column, key, params) {
  const w = periodWindow(key);
  if (!w) return null;
  params.push(w.from, w.to);
  const a = params.length - 1;
  const b = params.length;
  return `${column} >= ($${a}::date::timestamp AT TIME ZONE 'Asia/Yerevan') AND ${column} < (($${b}::date + 1)::timestamp AT TIME ZONE 'Asia/Yerevan')`;
}

/** The same for a DATE column. */
export function periodDateCondition(column, key, params) {
  const w = periodWindow(key);
  if (!w) return null;
  params.push(w.from, w.to);
  return `${column} >= $${params.length - 1}::date AND ${column} <= $${params.length}::date`;
}
