// Company calendar: Mon-Sat is a working day everywhere in the business,
// Sunday never is, and company_holidays (Armenian public holidays, admin-
// editable -- see migration 037) are the only other exceptions. Every
// pacing/forecast number in Team Performance is built on this, so it's the
// one place that logic lives.
import { pool } from "./db/pool.js";

export function isWorkingDayOfWeek(date) {
  return date.getUTCDay() !== 0; // 0 = Sunday
}

async function holidaysInRange(startDate, endDate) {
  const { rows } = await pool.query(
    "SELECT holiday_date FROM company_holidays WHERE holiday_date >= $1 AND holiday_date <= $2",
    [startDate, endDate]
  );
  return new Set(rows.map((r) => r.holiday_date.toISOString().slice(0, 10)));
}

// Total working days in the given month, and how many have elapsed as of
// `asOf` (defaults to now; capped at the month's last day, so a past
// month's plan doesn't read as "elapsed > total").
export async function workingDaysForMonth(monthDate, asOf = new Date()) {
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const holidays = await holidaysInRange(firstDay, lastDay);

  const cappedAsOf = asOf < firstDay ? new Date(firstDay.getTime() - 86400000) : asOf < lastDay ? asOf : lastDay;

  let total = 0;
  let elapsed = 0;
  for (let d = new Date(firstDay); d <= lastDay; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    if (!isWorkingDayOfWeek(d) || holidays.has(key)) continue;
    total += 1;
    if (d <= cappedAsOf) elapsed += 1;
  }
  return { total, elapsed, remaining: total - elapsed };
}
