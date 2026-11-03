// Vaghinak celebrates a staff birthday (owner, 2026-11-03: a longer, richer greeting; the gift is one paid day off the person picks; the whole team can
// congratulate). On the day, from 09:00 (an irregular minute like his other messages), the person gets his warm message with the days to choose
// from; the CEO and admin are told once; from 16:00 the person gets one more message naming the colleagues who congratulated.
// Safe to run any number of times: a message is unique per person / kind / day / level, the announcement once per person and year.
import { pool } from "../../db/pool.js";
import { notifyUser } from "../../shared/notifications.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { birthdaysOn, wishers, markBirthdayOff } from "../birthdays.js";
import { getVaghinakSettings } from "./settings.js";
import { createMessage, isWorkingDay, minuteOfDay, MANAGEMENT_ROLES } from "./engine.js";
import { humanDelayPassed } from "./humanDelay.js";

const WEEKDAY_HY = ["Կիրակի", "Երկուշաբթի", "Երեքշաբթի", "Չորեքշաբթի", "Հինգշաբթի", "Ուրբաթ", "Շաբաթ"];
const FROM_MIN = 9 * 60;
const WISHES_FROM_MIN = 16 * 60;
const UNTIL_MIN = 20 * 60;
const OFFER_DAYS = 6; // working days offered for the gift, starting today

const shiftDay = (day, delta) => new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86400000).toISOString().slice(0, 10);
const label = (day) => `${WEEKDAY_HY[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** The days the person may choose for the paid day off: the next working days that are not marked yet, then "not now". Keys are the dates. */
export async function giftChoices(db, staffId, day) {
  const { rows: marked } = await db.query("SELECT day::text AS day FROM staff_days WHERE staff_id = $1 AND day >= $2::date", [staffId, day]);
  const taken = new Set(marked.map((r) => r.day));
  const out = [];
  for (let i = 0; i < 14 && out.length < OFFER_DAYS; i++) {
    const d = shiftDay(day, i);
    if (taken.has(d) || !(await isWorkingDay(db, d))) continue;
    out.push({ key: d, label: label(d) });
  }
  out.push({ key: "none", label: "Այս անգամ ոչ" });
  return out;
}

async function announce(db, person, year) {
  const { rowCount } = await db.query("INSERT INTO staff_birthday_log (staff_id, year) VALUES ($1, $2) ON CONFLICT DO NOTHING", [person.staff_id, year]);
  if (!rowCount) return;
  const { rows } = await db.query("SELECT id FROM users WHERE role IN ('ceo', 'admin') AND status = 'active' AND id IS DISTINCT FROM $1", [person.user_id]);
  for (const u of rows) {
    notifyUser(u.id, "vaghinak", { title: "Վաղինակ", body: `Այսօր ${person.user_name_hy || person.user_name || person.name}-ի ծննդյան օրն է։ Շնորհավորեք նրան։`, url: "/#/dashboard" }).catch(() => {});
  }
}

export async function birthdayTick(now = new Date(), db = pool, { pick, delayMaxMs } = {}) {
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off") return { created: 0 };
  const day = yerevanToday(now);
  const nowMin = minuteOfDay(now);
  if (nowMin < FROM_MIN || nowMin >= UNTIL_MIN) return { created: 0 };
  if (!humanDelayPassed(day, "birthday", now, { maxMs: delayMaxMs, pick })) return { created: 0 };
  const list = await birthdaysOn(day, db);
  if (!list.length) return { created: 0 };
  const year = Number(day.slice(0, 4));
  let created = 0;
  for (const p of list) {
    await announce(db, p, year);
    if (!p.user_id || !p.user_role) continue;
    const user = { id: p.user_id, name: p.user_name, name_hy: p.user_name_hy, role: p.user_role, vaghinak_address: p.vaghinak_address };
    const audience = MANAGEMENT_ROLES.includes(p.user_role) ? "management" : "rep";
    const choices = await giftChoices(db, p.staff_id, day);
    if (await createMessage(db, user, { kind: "birthday", level: 1, day, audience, settings, pick, choices, needsAnswer: true, bypassCap: true })) created++;
    if (nowMin >= WISHES_FROM_MIN) {
      const names = await wishers(p.staff_id, year, db);
      if (names.length && (await createMessage(db, user, { kind: "birthday_wishes", level: 1, day, audience, ctx: { names: names.join(", ") }, settings, pick, bypassCap: true }))) created++;
    }
  }
  return { created };
}

/** The person picked a day in the birthday message: the paid day off is marked and the boss, the CEO and admin are told. */
export async function applyBirthdayChoice(db, userId, choice) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice ?? "")) return { applied: false };
  const { rows: [staff] } = await db.query("SELECT s.id, s.name, s.reports_to, b.user_id AS boss_user_id FROM staff_members s LEFT JOIN staff_members b ON b.id = s.reports_to WHERE s.user_id = $1", [userId]);
  if (!staff) return { applied: false };
  const applied = await markBirthdayOff(staff.id, choice, userId, db);
  if (applied) {
    const { rows } = await db.query("SELECT id FROM users WHERE role IN ('ceo', 'admin') AND status = 'active'");
    const ids = new Set([...rows.map((r) => r.id), ...(staff.boss_user_id ? [staff.boss_user_id] : [])]);
    ids.delete(userId);
    for (const id of ids) notifyUser(id, "vaghinak", { title: "Վաղինակ", body: `${staff.name}-ը ծննդյան վճարովի հանգստյան օր ընտրեց՝ ${label(choice)}։`, url: "/#/staff" }).catch(() => {});
  }
  return { applied };
}
