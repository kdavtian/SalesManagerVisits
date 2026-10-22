// Period buttons (owner, 2026-10-22): Today / This week / This month / This quarter / This year. Tapping the button that is
// ALREADY selected flips it to the previous period (Yesterday / Last week / Last month / Last quarter / Last year); tapping it
// again flips back; tapping another button selects that one (current period). One place for the labels and the rule, used by
// every row of period buttons in the app.
import { t } from "./i18n.js";

// base period -> [label key now, label key previous]
const LABELS = {
  today: ["pb_today", "pb_yesterday"],
  week: ["pb_week", "pb_last_week"],
  month: ["pb_month", "pb_last_month"],
  quarter: ["pb_quarter", "pb_last_quarter"],
  year: ["pb_year", "pb_last_year"],
};

// The server's key of the previous period of each base (see server/src/utils/periodWindows.js).
export const PERIOD_PREVIOUS = { today: "yesterday", week: "last_week", month: "last_month", quarter: "last_quarter", year: "last_year" };

export const periodLabel = (base, previous = false) => t(LABELS[base][previous ? 1 : 0]);

/** The key to send for a base period: "week" -> "week" / "last_week". */
export const periodKey = (base, previous = false) => (previous ? PERIOD_PREVIOUS[base] : base);

/**
 * What a tap does. `state` = { base, previous } (the selected button), `tapped` = the base of the tapped button.
 * Same button -> flip current/previous; another button -> that one, current period.
 */
export function tapPeriod(state, tapped) {
  if (state.base === tapped) return { base: tapped, previous: !state.previous };
  return { base: tapped, previous: false };
}

/** aria-label of a button that can flip, e.g. "Today. Tap again for Yesterday". */
export function periodAria(base, previous) {
  return t("pb_aria").replace("{now}", periodLabel(base, previous)).replace("{other}", periodLabel(base, !previous));
}

// ---- date windows (client side, for lists that filter by from/to dates) -----------------------------------------------------
// The same calendar rules as server/src/utils/periodWindows.js: weeks start on Monday, quarters are Jan-Mar / Apr-Jun / Jul-Sep /
// Oct-Dec, the current period ends today, a previous one is complete. Dates are "YYYY-MM-DD".
const pad = (n) => String(n).padStart(2, "0");
const utc = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
const monthEnd = (y, m) => fmt(new Date(Date.UTC(y, m, 0)));

export function periodDates(key, today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  const monday = addDays(today, -((utc(today).getUTCDay() + 6) % 7));
  switch (key) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week": return { from: monday, to: today };
    case "last_week": return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "month": return { from: `${y}-${pad(m)}-01`, to: today };
    case "last_month": { const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1; return { from: `${py}-${pad(pm)}-01`, to: monthEnd(py, pm) }; }
    case "quarter": return { from: `${y}-${pad(q0)}-01`, to: today };
    case "last_quarter": { const pq = q0 === 1 ? 10 : q0 - 3; const py = q0 === 1 ? y - 1 : y; return { from: `${py}-${pad(pq)}-01`, to: monthEnd(py, pq + 2) }; }
    case "year": return { from: `${y}-01-01`, to: today };
    case "last_year": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    default: return null;
  }
}

/** The label of any period key ("last_week" -> "Last week"), or "" when it is not one of the period buttons. */
export function periodKeyLabel(key) {
  for (const [base, [now, prev]] of Object.entries(LABELS)) {
    if (key === base) return t(now);
    if (key === PERIOD_PREVIOUS[base]) return t(prev);
  }
  return "";
}
