// Staff birthdays (owner, 2026-11-03). The day and month sit on the staff card (staff_members.birth_day / birth_month, migration 185; the year is never
// stored). Everything that needs "whose birthday is it" asks here: Vaghinak's congratulation (vaghinak/birthdays.js), the "Birthday today" line on
// Home with its one-tap "Congratulate" (routes/birthdays.js) and the paid day off the person picks as the gift.
import { pool } from "../db/pool.js";

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const isRealBirthday = (day, month) => Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** [month, day] pairs that count as the birthday on `day` ("YYYY-MM-DD"); 29 Feb is celebrated on 28 Feb in a year that has no 29 Feb. */
export function birthdayKeys(day) {
  const [y, m, d] = day.split("-").map(Number);
  const keys = [[m, d]];
  if (m === 2 && d === 28 && !isLeap(y)) keys.push([2, 29]);
  return keys;
}

/** Active staff whose birthday is `day`: [{ staff_id, name, user_id, user_name, user_name_hy, user_role, reports_to }]. */
export async function birthdaysOn(day, db = pool) {
  const keys = birthdayKeys(day);
  const { rows } = await db.query(
    `SELECT s.id AS staff_id, s.name, s.user_id, s.reports_to, u.name AS user_name, u.name_hy AS user_name_hy, u.role AS user_role, u.vaghinak_address
     FROM staff_members s LEFT JOIN users u ON u.id = s.user_id AND u.status = 'active'
     WHERE s.active AND (s.start_date IS NULL OR s.start_date <= $1::date) AND (s.end_date IS NULL OR s.end_date >= $1::date)
       AND (s.birth_month, s.birth_day) IN (${keys.map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::int)`).join(", ")})
     ORDER BY s.name`,
    [day, ...keys.flat()]
  );
  return rows;
}

/** One colleague's wish; false when it was already given. */
export async function addWish(staffId, year, fromUserId, db = pool) {
  const { rowCount } = await db.query("INSERT INTO staff_birthday_wishes (staff_id, year, from_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [staffId, year, fromUserId]);
  return rowCount > 0;
}

/** Who congratulated (display names) in the order they did. */
export async function wishers(staffId, year, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(u.name_hy, u.name) AS name FROM staff_birthday_wishes w JOIN users u ON u.id = w.from_user_id WHERE w.staff_id = $1 AND w.year = $2 ORDER BY w.created_at`,
    [staffId, year]
  );
  return rows.map((r) => r.name);
}

/** The birthday gift: a paid day off that does not use the allowance. Never overwrites a mark management already put on that day. */
export async function markBirthdayOff(staffId, day, markedBy, db = pool) {
  const { rowCount } = await db.query(
    `INSERT INTO staff_days (staff_id, day, status, note, marked_by) VALUES ($1, $2, 'birthday_off', 'Birthday', $3) ON CONFLICT (staff_id, day) DO NOTHING`,
    [staffId, day, markedBy]
  );
  return rowCount > 0;
}
